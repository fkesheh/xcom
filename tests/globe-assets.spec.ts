import { expect, test } from "@playwright/test";

test("cloud alpha does not turn Antarctic ground brightness into an opaque cap", async ({ page }) => {
  await page.goto("/");
  const bands = await page.evaluate(async () => {
    const image = new Image();
    image.src = "/assets/earth-cloud-alpha-2048.jpg";
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) throw new Error("2D canvas unavailable");
    context.drawImage(image, 0, 0);

    const mean = (startY: number, height: number): number => {
      const pixels = context.getImageData(0, startY, canvas.width, height).data;
      let total = 0;
      for (let i = 0; i < pixels.length; i += 4) total += pixels[i]!;
      return total / (pixels.length / 4);
    };

    return {
      south: mean(canvas.height - 180, 180),
      equator: mean(Math.floor((canvas.height - 180) / 2), 180),
    };
  });

  expect(bands.south / bands.equator).toBeLessThan(1.5);
});
