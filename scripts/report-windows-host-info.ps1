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
$disks = @(Get-CimInstance Win32_DiskDrive)
$volumes = @(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3")
$addresses = @(
    Get-CimInstance Win32_NetworkAdapterConfiguration -Filter "IPEnabled=True" |
        ForEach-Object { $_.IPAddress } |
        Where-Object { $_ -and $_ -notlike "fe80:*" } |
        Sort-Object -Unique
)

$secureBoot = $null
try { $secureBoot = [bool](Confirm-SecureBootUEFI) } catch { }

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
    disks = @($disks | ForEach-Object {
        [ordered]@{
            model = $_.Model
            interface = $_.InterfaceType
            size_bytes = Convert-NullableUInt64 $_.Size
        }
    })
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
