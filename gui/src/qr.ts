// QR codes as SVG (and PNG for downloads).
import { encode } from 'uqr';

const QUIET = 4;

/** An SVG document with a black-and-white QR code of `text`. */
export function qrSvg(text: string, pixels = 512): string {
  const qr = encode(text, { ecc: 'M', border: 0 });
  const total = qr.size + QUIET * 2;
  let path = '';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) if (qr.data[y][x]) path += `M${x + QUIET} ${y + QUIET}h1v1h-1z`;
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixels}" height="${pixels}" shape-rendering="crispEdges">` +
    `<rect width="${total}" height="${total}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`
  );
}

/** Renders an SVG document to a PNG. */
export function svgToPng(svg: string, pixels = 1024): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = pixels;
      canvas.height = pixels;
      const context = canvas.getContext('2d');
      if (!context) return reject(new Error('Canvas is not available'));
      context.drawImage(image, 0, 0, pixels, pixels);
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not draw the image'))), 'image/png');
    };
    image.onerror = () => reject(new Error('Could not draw the image'));
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
}

export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
