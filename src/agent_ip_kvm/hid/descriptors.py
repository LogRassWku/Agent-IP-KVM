"""Standard USB HID report descriptors used by the ConfigFS backend plan."""

from __future__ import annotations


# Eight-byte boot keyboard report:
# modifier, reserved, and up to six simultaneous key usages.
BOOT_KEYBOARD_REPORT_DESCRIPTOR = bytes.fromhex(
    "05 01"  # Usage Page (Generic Desktop)
    "09 06"  # Usage (Keyboard)
    "a1 01"  # Collection (Application)
    "05 07"  # Usage Page (Keyboard)
    "19 e0"  # Usage Minimum (Left Control)
    "29 e7"  # Usage Maximum (Right GUI)
    "15 00"  # Logical Minimum (0)
    "25 01"  # Logical Maximum (1)
    "75 01"  # Report Size (1)
    "95 08"  # Report Count (8)
    "81 02"  # Input (Data, Variable, Absolute)
    "95 01"  # Report Count (1)
    "75 08"  # Report Size (8)
    "81 01"  # Input (Constant)
    "95 05"  # Report Count (5)
    "75 01"  # Report Size (1)
    "05 08"  # Usage Page (LEDs)
    "19 01"  # Usage Minimum (Num Lock)
    "29 05"  # Usage Maximum (Kana)
    "91 02"  # Output (Data, Variable, Absolute)
    "95 01"  # Report Count (1)
    "75 03"  # Report Size (3)
    "91 01"  # Output (Constant)
    "95 06"  # Report Count (6)
    "75 08"  # Report Size (8)
    "15 00"  # Logical Minimum (0)
    "25 65"  # Logical Maximum (101)
    "05 07"  # Usage Page (Keyboard)
    "19 00"  # Usage Minimum (Reserved)
    "29 65"  # Usage Maximum (Keyboard Application)
    "81 00"  # Input (Data, Array)
    "c0"     # End Collection
)


# Four-byte relative mouse report: five buttons, X, Y, and vertical wheel.
RELATIVE_MOUSE_REPORT_DESCRIPTOR = bytes.fromhex(
    "05 01"  # Usage Page (Generic Desktop)
    "09 02"  # Usage (Mouse)
    "a1 01"  # Collection (Application)
    "09 01"  # Usage (Pointer)
    "a1 00"  # Collection (Physical)
    "05 09"  # Usage Page (Buttons)
    "19 01"  # Usage Minimum (Button 1)
    "29 05"  # Usage Maximum (Button 5)
    "15 00"  # Logical Minimum (0)
    "25 01"  # Logical Maximum (1)
    "95 05"  # Report Count (5)
    "75 01"  # Report Size (1)
    "81 02"  # Input (Data, Variable, Absolute)
    "95 01"  # Report Count (1)
    "75 03"  # Report Size (3)
    "81 01"  # Input (Constant)
    "05 01"  # Usage Page (Generic Desktop)
    "09 30"  # Usage (X)
    "09 31"  # Usage (Y)
    "09 38"  # Usage (Wheel)
    "15 81"  # Logical Minimum (-127)
    "25 7f"  # Logical Maximum (127)
    "75 08"  # Report Size (8)
    "95 03"  # Report Count (3)
    "81 06"  # Input (Data, Variable, Relative)
    "c0"     # End Physical Collection
    "c0"     # End Application Collection
)


# One-byte System Control report. Bit 2 is Wake Up (USB HID usage 0x83).
# This is separate from the boot keyboard interface so operating systems can
# decide whether the device is allowed to wake a sleeping host.
SYSTEM_CONTROL_REPORT_DESCRIPTOR = bytes.fromhex(
    "05 01"  # Usage Page (Generic Desktop)
    "09 80"  # Usage (System Control)
    "a1 01"  # Collection (Application)
    "15 00"  # Logical Minimum (0)
    "25 01"  # Logical Maximum (1)
    "75 01"  # Report Size (1)
    "95 03"  # Report Count (3)
    "09 81"  # Usage (System Power Down)
    "09 82"  # Usage (System Sleep)
    "09 83"  # Usage (System Wake Up)
    "81 02"  # Input (Data, Variable, Absolute)
    "95 05"  # Report Count (5)
    "81 01"  # Input (Constant)
    "c0"     # End Collection
)


# Six-byte absolute pointer report: eight buttons, 16-bit X/Y, and vertical wheel.
# X/Y use the full 0..32767 logical desktop range so a browser coordinate can be
# mapped directly without relying on host pointer acceleration.
ABSOLUTE_POINTER_REPORT_DESCRIPTOR = bytes.fromhex(
    "05 01"  # Usage Page (Generic Desktop)
    "09 02"  # Usage (Mouse)
    "a1 01"  # Collection (Application)
    "09 01"  # Usage (Pointer)
    "a1 00"  # Collection (Physical)
    "05 09"  # Usage Page (Buttons)
    "19 01"  # Usage Minimum (Button 1)
    "29 08"  # Usage Maximum (Button 8)
    "15 00"  # Logical Minimum (0)
    "25 01"  # Logical Maximum (1)
    "95 08"  # Report Count (8)
    "75 01"  # Report Size (1)
    "81 02"  # Input (Data, Variable, Absolute)
    "05 01"  # Usage Page (Generic Desktop)
    "09 30"  # Usage (X)
    "09 31"  # Usage (Y)
    "16 00 00"  # Logical Minimum (0)
    "26 ff 7f"  # Logical Maximum (32767)
    "75 10"  # Report Size (16)
    "95 02"  # Report Count (2)
    "81 02"  # Input (Data, Variable, Absolute)
    "09 38"  # Usage (Wheel)
    "15 81"  # Logical Minimum (-127)
    "25 7f"  # Logical Maximum (127)
    "75 08"  # Report Size (8)
    "95 01"  # Report Count (1)
    "81 06"  # Input (Data, Variable, Relative)
    "c0"     # End Physical Collection
    "c0"     # End Application Collection
)
