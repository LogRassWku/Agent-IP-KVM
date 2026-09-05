param(
    [Parameter(Mandatory = $true)]
    [string]$KvmUrl,
    [string]$OutputFile
)

$ErrorActionPreference = "Stop"

function Convert-NullableUInt64($Value) {
    if ($null -eq $Value -or "$Value" -eq "") { return $null }
    return [UInt64]$Value
}

$computer = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$processors = @(Get-CimInstance Win32_Processor)
$memoryModules = @(Get-CimInstance Win32_PhysicalMemory)
$gpus = @(Get-CimInstance Win32_VideoController)
$bios = Get-CimInstance Win32_BIOS
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")
$addresses = @(
    Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" |
        ForEach-Object { $_.IPAddress } |
        Where-Object { $_ -and $_ -notlike "fe80:*" } |
        Sort-Object -Unique
)

$secureBoot = $null
try { $secureBoot = [bool](Confirm-SecureBootUEFI) } catch { }

$diskInventory = @()
try {
    $diskInventory = @(Get-Disk -ErrorAction Stop | Sort-Object Number | ForEach-Object {
        $disk = $_
        $partitionInventory = @(Get-Partition -DiskNumber $disk.Number -ErrorAction Stop | Sort-Object PartitionNumber | ForEach-Object {
            $partition = $_
            $volume = $null
            try { $volume = $partition | Get-Volume -ErrorAction Stop } catch { }
            [ordered]@{
                number = [int]$partition.PartitionNumber
                name = if ($partition.DriveLetter) { "$($partition.DriveLetter):" } else { $null }
                label = if ($volume) { $volume.FileSystemLabel } else { $null }
                filesystem = if ($volume) { [string]$volume.FileSystem } else { $null }
                type = [string]$partition.Type
                size_bytes = Convert-NullableUInt64 $partition.Size
                free_bytes = if ($volume) { Convert-NullableUInt64 $volume.SizeRemaining } else { $null }
                is_boot = [bool]$partition.IsBoot
                is_system = [bool]$partition.IsSystem
                is_hidden = [bool]$partition.IsHidden
            }
        })
        [ordered]@{
            number = [int]$disk.Number
            model = $disk.FriendlyName
            interface = [string]$disk.BusType
            partition_style = [string]$disk.PartitionStyle
            health = [string]$disk.HealthStatus
            operational_status = (($disk.OperationalStatus | ForEach-Object { [string]$_ }) -join ", ")
            size_bytes = Convert-NullableUInt64 $disk.Size
            allocated_bytes = Convert-NullableUInt64 $disk.AllocatedSize
            partitions = $partitionInventory
        }
    })
} catch {
    $diskInventory = @(Get-CimInstance Win32_DiskDrive | Sort-Object Index | ForEach-Object {
        [ordered]@{
            number = [int]$_.Index
            model = $_.Model
            interface = $_.InterfaceType
            partition_style = $null
            health = $_.Status
            operational_status = $null
            size_bytes = Convert-NullableUInt64 $_.Size
            allocated_bytes = $null
            partitions = @()
        }
    })
}

$payload = [ordered]@{
    schema_version = 1
    collected_at = (Get-Date).ToUniversalTime().ToString("o")
    hostname = $env:COMPUTERNAME
    os = [ordered]@{
        name = $os.Caption
        version = $os.Version
        build = $os.BuildNumber
        architecture = $os.OSArchitecture
        last_boot = $os.LastBootUpTime.ToUniversalTime().ToString("o")
    }
    system = [ordered]@{
        manufacturer = $computer.Manufacturer
        model = $computer.Model
    }
    bios = [ordered]@{
        manufacturer = $bios.Manufacturer
        version = $bios.SMBIOSBIOSVersion
        release_date = if ($bios.ReleaseDate) { $bios.ReleaseDate.ToUniversalTime().ToString("o") } else { $null }
        secure_boot = $secureBoot
    }
    cpu = [ordered]@{
        model = (($processors | ForEach-Object { $_.Name.Trim() }) -join "; ")
        physical_cores = [int](($processors | Measure-Object NumberOfCores -Sum).Sum)
        logical_processors = [int](($processors | Measure-Object NumberOfLogicalProcessors -Sum).Sum)
        max_clock_mhz = [int](($processors | Measure-Object MaxClockSpeed -Maximum).Maximum)
    }
    memory = [ordered]@{
        total_bytes = [UInt64]$computer.TotalPhysicalMemory
        modules = @($memoryModules | ForEach-Object {
            [ordered]@{
                capacity_bytes = Convert-NullableUInt64 $_.Capacity
                speed_mts = [int]$(if ($_.ConfiguredClockSpeed) { $_.ConfiguredClockSpeed } else { $_.Speed })
                manufacturer = $_.Manufacturer
                part_number = if ($_.PartNumber) { $_.PartNumber.Trim() } else { $null }
            }
        })
    }
    gpus = @($gpus | ForEach-Object {
        [ordered]@{
            name = $_.Name
            driver_version = $_.DriverVersion
            memory_bytes = Convert-NullableUInt64 $_.AdapterRAM
        }
    })
    disks = $diskInventory
    volumes = @($volumes | ForEach-Object {
        [ordered]@{
            name = $_.DeviceID
            label = $_.VolumeName
            filesystem = $_.FileSystem
            size_bytes = Convert-NullableUInt64 $_.Size
            free_bytes = Convert-NullableUInt64 $_.FreeSpace
        }
    })
    network = [ordered]@{ addresses = $addresses }
}

$json = $payload | ConvertTo-Json -Depth 8 -Compress
if ($OutputFile) {
    [System.IO.File]::WriteAllText((Join-Path (Get-Location) $OutputFile), $json, [System.Text.UTF8Encoding]::new($false))
}

$uri = $KvmUrl.TrimEnd("/") + "/api/host-info"
$result = Invoke-RestMethod -Uri $uri -Method Post -ContentType "application/json; charset=utf-8" -Body ([System.Text.Encoding]::UTF8.GetBytes($json))
Write-Host "Host information sent to $uri"
Write-Host "Collected at: $($result.controlled_host.updated_at)"
