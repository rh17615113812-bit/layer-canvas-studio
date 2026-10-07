/** Outline alignment symbols, independent of the system font. */
const paths = {
  left: 'M3 2v20 M7 5h13v5H7z M7 14h8v5H7z',
  centerX: 'M12 2v3 M12 10v4 M12 19v3 M4 5h16v5H4z M7 14h10v5H7z',
  right: 'M21 2v20 M4 5h13v5H4z M9 14h8v5H9z',
  top: 'M2 3h20 M5 7h5v13H5z M14 7h5v8h-5z',
  centerY: 'M2 12h3 M10 12h4 M19 12h3 M5 4h5v16H5z M14 7h5v10h-5z',
  bottom: 'M2 21h20 M5 4h5v13H5z M14 9h5v8h-5z',
  spaceX: 'M3 3v18 M21 3v18 M9 5h6v14H9z M5 12h2 M17 12h2',
  spaceY: 'M3 3h18 M3 21h18 M5 9h14v6H5z M12 5v2 M12 17v2',
};

export function createAlignmentIcon(mode: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '20'); svg.setAttribute('height', '20');
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[mode]); svg.append(path);
  return svg;
}
