from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT_DIR = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT_DIR / "frontend" / "public" / "images" / "navbar-icons"
ICON_SIZE = 512
STROKE_COLOR = "#0f172a"
BACKGROUND = (255, 255, 255, 0)


def _scale(value: float) -> float:
    return value * ICON_SIZE / 24.0


def _rounded_rect(draw: ImageDraw.ImageDraw, xy, radius: float, width: int) -> None:
    draw.rounded_rectangle(xy, radius=radius, outline=STROKE_COLOR, width=width)


def _home_icon() -> Image.Image:
    image = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    width = 22

    house = [(_scale(3), _scale(10)), (_scale(12), _scale(3)), (_scale(21), _scale(10))]
    draw.line(house, fill=STROKE_COLOR, width=width, joint="curve")
    draw.line([house[-1], (_scale(21), _scale(21))], fill=STROKE_COLOR, width=width)
    draw.line([(_scale(21), _scale(21)), (_scale(3), _scale(21))], fill=STROKE_COLOR, width=width)
    draw.line([(_scale(3), _scale(21)), house[0]], fill=STROKE_COLOR, width=width)

    draw.rounded_rectangle(
        [_scale(10), _scale(14), _scale(14), _scale(21)],
        radius=_scale(0.5),
        outline=STROKE_COLOR,
        width=width,
    )
    return image


def _dashboard_icon() -> Image.Image:
    image = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    width = 22

    _rounded_rect(
        draw,
        [_scale(3), _scale(3), _scale(21), _scale(21)],
        radius=_scale(3),
        width=width,
    )

    draw.arc(
        [_scale(7), _scale(5), _scale(17), _scale(15)],
        start=180,
        end=360,
        fill=STROKE_COLOR,
        width=width,
    )
    draw.line(
        [(_scale(12), _scale(15)), (_scale(14.5), _scale(10.7))],
        fill=STROKE_COLOR,
        width=width,
    )
    return image


def _forecast_icon() -> Image.Image:
    image = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    width = 22

    _rounded_rect(
        draw,
        [_scale(3), _scale(3), _scale(21), _scale(21)],
        radius=_scale(3),
        width=width,
    )

    draw.line(
        [(_scale(6), _scale(16)), (_scale(10), _scale(13)), (_scale(14), _scale(15)), (_scale(18), _scale(9))],
        fill=STROKE_COLOR,
        width=width,
        joint="curve",
    )
    draw.line(
        [(_scale(16), _scale(9)), (_scale(18), _scale(9)), (_scale(18), _scale(11))],
        fill=STROKE_COLOR,
        width=width,
        joint="curve",
    )
    return image


def _controller_icon() -> Image.Image:
    image = Image.new("RGBA", (ICON_SIZE, ICON_SIZE), BACKGROUND)
    draw = ImageDraw.Draw(image)
    width = 22

    _rounded_rect(
        draw,
        [_scale(3), _scale(3), _scale(21), _scale(21)],
        radius=_scale(3),
        width=width,
    )

    for y in (8, 12, 16):
        draw.line([(_scale(7), _scale(y)), (_scale(17), _scale(y))], fill=STROKE_COLOR, width=width)

    for cx, cy in ((10, 8), (15, 12), (11, 16)):
        r = _scale(2)
        draw.ellipse([_scale(cx) - r, _scale(cy) - r, _scale(cx) + r, _scale(cy) + r], fill=STROKE_COLOR)

    return image


def _contact_sheet(images: dict[str, Image.Image]) -> Image.Image:
    font = ImageFont.load_default()
    label_height = 36
    gap = 28
    card_size = ICON_SIZE + label_height + gap
    sheet = Image.new("RGBA", (card_size * len(images), card_size), (255, 255, 255, 255))
    draw = ImageDraw.Draw(sheet)

    for index, (name, image) in enumerate(images.items()):
        x = index * card_size
        sheet.alpha_composite(image, (x + gap // 2, 0))
        draw.text((x + 24, ICON_SIZE + 10), name.title(), fill="#111827", font=font)

    return sheet


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    icons = {
        "home": _home_icon(),
        "dashboard": _dashboard_icon(),
        "forecast": _forecast_icon(),
        "controller": _controller_icon(),
    }

    for name, image in icons.items():
        image.save(OUTPUT_DIR / f"{name}_navbar_icon.png")

    _contact_sheet(icons).save(OUTPUT_DIR / "navbar_icons_contact_sheet.png")

    print(f"Rendered {len(icons)} navbar icons to {OUTPUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
