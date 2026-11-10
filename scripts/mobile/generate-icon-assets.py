#!/usr/bin/env python3
"""Generate Android launcher assets from the desktop application's source PNG.

Requires Pillow (see requirements-icons.txt). Run from any directory; paths are
resolved from this script. The existing splash image already uses this artwork.
"""

import argparse
from pathlib import Path

from PIL import Image, ImageDraw


DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
LAYER_DP = 108
ARTWORK_DP = 66
VIEWPORT_DP = 72
LAUNCHER_DP = 48


def extend_edges(artwork: Image.Image, size: int) -> Image.Image:
    """Fill the adaptive layer by extending edge pixels, without a second image.

    Keep the complete artwork in Android's central 66dp safe area. Extending its
    edges through the 108dp layer makes every launcher mask full bleed, avoiding
    a visible square inset or colored frame. OEM masks may trim peripheral
    background/clothes; the face, ears and hair remain in the central artwork.
    """
    side = artwork.width
    pad = (size - side) // 2
    tail = size - side - pad
    layer = Image.new("RGBA", (size, size))
    layer.paste(artwork, (pad, pad))
    layer.paste(artwork.crop((0, 0, 1, side)).resize((pad, side)), (0, pad))
    layer.paste(
        artwork.crop((side - 1, 0, side, side)).resize((tail, side)),
        (pad + side, pad),
    )
    layer.paste(layer.crop((0, pad, size, pad + 1)).resize((size, pad)), (0, 0))
    layer.paste(
        layer.crop((0, pad + side - 1, size, pad + side)).resize((size, tail)),
        (0, pad + side),
    )
    return layer


def write_png(image: Image.Image, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, format="PNG", optimize=False, compress_level=9)
    print(f"{path}: {image.width}x{image.height}")


def generate(root: Path, source_path: Path) -> None:
    with Image.open(source_path) as source_image:
        source = source_image.convert("RGBA")
    if source.width != source.height:
        raise ValueError("Icon source must be square, like the desktop source PNG")

    resources = root / "apps/mobile/android/app/src/main/res"
    for density, scale in DENSITIES.items():
        directory = resources / f"mipmap-{density}"
        size = round(LAUNCHER_DP * scale)
        write_png(
            source.resize((size, size), Image.Resampling.LANCZOS),
            directory / "ic_launcher.png",
        )

        layer_size = round(LAYER_DP * scale)
        art_size = round(ARTWORK_DP * scale)
        foreground = extend_edges(
            source.resize((art_size, art_size), Image.Resampling.LANCZOS),
            layer_size,
        )
        write_png(foreground, directory / "ic_launcher_foreground.png")

        # The pre-API-26 round fallback uses the same crop as adaptive launchers.
        # Supersampling keeps the legacy circular mask clean at low densities.
        large_size = size * 4
        viewport = round(VIEWPORT_DP * scale)
        inset = (layer_size - viewport) // 2
        round_image = foreground.crop(
            (inset, inset, inset + viewport, inset + viewport)
        ).resize((large_size, large_size), Image.Resampling.LANCZOS)
        mask = Image.new("L", (large_size, large_size))
        ImageDraw.Draw(mask).ellipse((0, 0, large_size - 1, large_size - 1), fill=255)
        round_image.putalpha(mask)
        write_png(
            round_image.resize((size, size), Image.Resampling.LANCZOS),
            directory / "ic_launcher_round.png",
        )

    # The foreground is full bleed; use its light blue artwork background as the
    # fallback behind the layer during launcher-generated motion effects.
    red, green, blue, _ = source.getpixel((0, 0))
    color = f"#{red:02x}{green:02x}{blue:02x}"
    (resources / "values/ic_launcher_background.xml").write_text(
        '<?xml version="1.0" encoding="utf-8"?>\n'
        "<resources>\n"
        f'    <color name="ic_launcher_background">{color}</color>\n'
        "</resources>\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--repository-root", type=Path, default=Path(__file__).resolve().parents[2]
    )
    parser.add_argument("--source", type=Path, help="Defaults to the desktop source PNG")
    args = parser.parse_args()
    root = args.repository_root.resolve()
    source = args.source or root / "assets/selbstlauf-icon-source.png"
    generate(root, source.resolve())


if __name__ == "__main__":
    main()
