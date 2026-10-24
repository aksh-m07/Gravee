#!/bin/zsh
# Convert UCSD Ped1/Ped2 TIFF (PackBits) frames to PNG with macOS sips. Output: data/ped-png/<same layout>
cd "$(dirname "$0")"
find data/raw/UCSDped1 data/raw/UCSDped2 -name '*.tif' -print0 | xargs -0 -n 1 -P 6 zsh -c '
  src="$1"; dst="data/ped-png/${src#data/raw/}"; dst="${dst%.tif}.png"
  mkdir -p "$(dirname "$dst")"; sips -s format png "$src" --out "$dst" >/dev/null 2>&1' _
echo converted > data/ped-png/DONE
