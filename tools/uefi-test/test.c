#include <efi.h>
#include <efilib.h>

EFI_STATUS EFIAPI efi_main(EFI_HANDLE image_handle, EFI_SYSTEM_TABLE *system_table) {
    InitializeLib(image_handle, system_table);
    ST->ConOut->ClearScreen(ST->ConOut);
    Print(L"Agent IP KVM USB Boot OK\r\n\r\n");
    Print(L"UEFI can start the development board virtual USB disk.\r\n");
    Print(L"This is a non-destructive test image.\r\n");
    Print(L"Press any key to return to the firmware boot menu.\r\n");

    UINTN index;
    ST->BootServices->WaitForEvent(1, &ST->ConIn->WaitForKey, &index);
    return EFI_SUCCESS;
}
