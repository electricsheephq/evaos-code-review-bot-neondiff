#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

check_hash() {
  expected=$1
  path=$2
  actual=$(shasum -a 256 "$ROOT/$path" | awk '{print $1}')
  if [ "$actual" != "$expected" ]; then
    echo "checksum mismatch: $path" >&2
    exit 1
  fi
}

check_pixels() {
  width=$1
  height=$2
  path=$3
  actual_width=$(sips -g pixelWidth "$ROOT/$path" | awk '/pixelWidth/{print $2}')
  actual_height=$(sips -g pixelHeight "$ROOT/$path" | awk '/pixelHeight/{print $2}')
  if [ "$actual_width" != "$width" ] || [ "$actual_height" != "$height" ]; then
    echo "unexpected dimensions: $path ($actual_width x $actual_height)" >&2
    exit 1
  fi
}

check_hash f4688800de72ff98b2a2e490d8f765301b2afa07113dceb628aa1624494ee6e9 wordmark/neondiff-wordmark-light-1x.png
check_hash 13d83b5575c88b81635bc324cf3363be643716f72e172c9916bcb21f87883a59 wordmark/neondiff-wordmark-light-2x.png
check_hash d1fc5eb34fdbe2967e866d22c0e62b48002be1ccdcf490c864a3c8ec0b49ff70 wordmark/neondiff-wordmark-dark-1x.png
check_hash 65a3912771d104b1959aff75c9653956dea2bb5adf0684dbd722bea022d5005b wordmark/neondiff-wordmark-dark-2x.png
check_hash c73cfbe13482080b86e637cbe483ba59069a11ea1add57de9cea7d608e88e3eb app-icon/light/neondiff-app-icon-light-1024.png
check_hash bbf80d563232f94ea7f1a9535a24fbdc9cb498b38864038497e3ab161f7acc27 app-icon/dark/neondiff-app-icon-dark-1024.png
check_hash d9e4c99511665fdc9c66cb37767fe5d9dbacff25c7b84a2e73a90929b42e9ff4 app-icon/NeonDiff.icns
check_hash d9e4c99511665fdc9c66cb37767fe5d9dbacff25c7b84a2e73a90929b42e9ff4 app-icon/light/NeonDiff-Light.icns
check_hash b608fe13e8460d0fe674855666ea3d6c0e26d7d010a334d2502ea199166a9ae5 app-icon/dark/NeonDiff-Dark.icns

check_pixels 932 119 wordmark/neondiff-wordmark-light-1x.png
check_pixels 1864 238 wordmark/neondiff-wordmark-light-2x.png
check_pixels 932 119 wordmark/neondiff-wordmark-dark-1x.png
check_pixels 1864 238 wordmark/neondiff-wordmark-dark-2x.png
check_pixels 1024 1024 app-icon/light/neondiff-app-icon-light-1024.png
check_pixels 1024 1024 app-icon/dark/neondiff-app-icon-dark-1024.png

for mode in light dark; do
  set_name=AppIcon-Light.iconset
  [ "$mode" = dark ] && set_name=AppIcon-Dark.iconset
  set_path="$ROOT/app-icon/$mode/$set_name"
  jq -e '
    (.images | length) == 10
    and ([.images[].filename] | unique | length) == 10
    and ([.images[] | [.filename, .idiom, .scale, .size]] == [
      ["icon_16x16.png", "mac", "1x", "16x16"],
      ["icon_16x16@2x.png", "mac", "2x", "16x16"],
      ["icon_32x32.png", "mac", "1x", "32x32"],
      ["icon_32x32@2x.png", "mac", "2x", "32x32"],
      ["icon_128x128.png", "mac", "1x", "128x128"],
      ["icon_128x128@2x.png", "mac", "2x", "128x128"],
      ["icon_256x256.png", "mac", "1x", "256x256"],
      ["icon_256x256@2x.png", "mac", "2x", "256x256"],
      ["icon_512x512.png", "mac", "1x", "512x512"],
      ["icon_512x512@2x.png", "mac", "2x", "512x512"]
    ])
  ' "$set_path/Contents.json" >/dev/null
  check_pixels 16 16 "app-icon/$mode/$set_name/icon_16x16.png"
  check_pixels 32 32 "app-icon/$mode/$set_name/icon_16x16@2x.png"
  check_pixels 32 32 "app-icon/$mode/$set_name/icon_32x32.png"
  check_pixels 64 64 "app-icon/$mode/$set_name/icon_32x32@2x.png"
  check_pixels 128 128 "app-icon/$mode/$set_name/icon_128x128.png"
  check_pixels 256 256 "app-icon/$mode/$set_name/icon_128x128@2x.png"
  check_pixels 256 256 "app-icon/$mode/$set_name/icon_256x256.png"
  check_pixels 512 512 "app-icon/$mode/$set_name/icon_256x256@2x.png"
  check_pixels 512 512 "app-icon/$mode/$set_name/icon_512x512.png"
  check_pixels 1024 1024 "app-icon/$mode/$set_name/icon_512x512@2x.png"
done

if find "$ROOT" -type f \( -name '*.ttf' -o -name '*.otf' -o -name '.DS_Store' \) -print -quit | grep -q .; then
  echo "forbidden font or Finder metadata found in brand assets" >&2
  exit 1
fi

echo "NeonDiff brand asset verification passed"
