#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
OUT_DIR=${UEFI_TEST_OUT_DIR:-"$ROOT_DIR/work/uefi-test"}
IMAGE="$OUT_DIR/agent-ip-kvm-uefi-test.img"
EFI_FILE="$OUT_DIR/BOOTX64.EFI"

EFI_INCLUDE=${EFI_INCLUDE:-/usr/include/efi}
EFI_LIB=${EFI_LIB:-/usr/lib}
EFI_LDS=${EFI_LDS:-$EFI_LIB/elf_x86_64_efi.lds}
EFI_CRT=${EFI_CRT:-$EFI_LIB/crt0-efi-x86_64.o}

for command in gcc ld objcopy mkfs.fat; do
    command -v "$command" >/dev/null || {
        echo "required command not found: $command" >&2
        exit 1
    }
done
for file in "$EFI_INCLUDE/efi.h" "$EFI_INCLUDE/efilib.h" "$EFI_LIB/libgnuefi.a" "$EFI_LIB/libefi.a" "$EFI_LDS" "$EFI_CRT"; do
    test -f "$file" || {
        echo "required gnu-efi file not found: $file" >&2
        exit 1
    }
done

MTOOLS_DIR=${MTOOLS_DIR:-}
if [ -n "$MTOOLS_DIR" ]; then
    MCOPY="$MTOOLS_DIR/mcopy"
    MMD="$MTOOLS_DIR/mmd"
    MTYPE="$MTOOLS_DIR/mtype"
else
    MCOPY=$(command -v mcopy)
    MMD=$(command -v mmd)
    MTYPE=$(command -v mtype)
fi

mkdir -p "$OUT_DIR"
rm -f "$OUT_DIR/test.o" "$OUT_DIR/test.so" "$EFI_FILE" "$IMAGE"

gcc -I"$EFI_INCLUDE" -fno-stack-protector -fpic -fshort-wchar -mno-red-zone \
    -Wall -DEFI_FUNCTION_WRAPPER -c "$ROOT_DIR/tools/uefi-test/test.c" \
    -o "$OUT_DIR/test.o"
ld -nostdlib -znocombreloc -T "$EFI_LDS" -shared -Bsymbolic "$EFI_CRT" \
    "$OUT_DIR/test.o" -L"$EFI_LIB" -lgnuefi -lefi -o "$OUT_DIR/test.so"
objcopy -j .text -j .sdata -j .data -j .dynamic -j .dynsym \
    -j .rel -j .rela -j .rel.* -j .rela.* -j .reloc \
    --output-target=efi-app-x86_64 --subsystem=10 "$OUT_DIR/test.so" "$EFI_FILE"

dd if=/dev/zero of="$IMAGE" bs=1M count=32 status=none
mkfs.fat -F 32 -n AGENTKVM "$IMAGE" >/dev/null
export MTOOLS_SKIP_CHECK=1
"$MMD" -i "$IMAGE" ::/EFI
"$MMD" -i "$IMAGE" ::/EFI/BOOT
"$MCOPY" -i "$IMAGE" "$EFI_FILE" ::/EFI/BOOT/BOOTX64.EFI
printf 'Agent IP KVM UEFI test image\r\n' > "$OUT_DIR/README.TXT"
"$MCOPY" -i "$IMAGE" "$OUT_DIR/README.TXT" ::/README.TXT

echo "created: $IMAGE"
sha256sum "$IMAGE"
