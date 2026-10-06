import type { ResultSet } from '../../shared/types';

const ROW_HEIGHT = 22;
const OVERSCAN = 10;
const CHAR_WIDTH = 7.3;
const MIN_COLUMN_WIDTH = 60;
const MAX_COLUMN_WIDTH = 360;
const WIDTH_SAMPLE_ROWS = 200;
const ROWNUM_WIDTH = 52;

function cell(text: string, width: number, className = ''): HTMLDivElement {
  const el = document.createElement('div');
  el.className = `grid-cell ${className}`.trim();
  el.style.width = `${width}px`;
  el.textContent = text;
  return el;
}

/** Renders a result set, drawing only the rows inside the viewport. */
export function renderGrid(host: HTMLElement, result: ResultSet): void {
  const widths = result.columns.map((name, c) => {
    let chars = name.length;
    for (const row of result.rows.slice(0, WIDTH_SAMPLE_ROWS)) {
      chars = Math.max(chars, String(row[c] ?? 'NULL').length);
    }
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(chars * CHAR_WIDTH) + 14));
  });
  const totalWidth = ROWNUM_WIDTH + widths.reduce((a, b) => a + b, 0);

  const grid = document.createElement('div');
  grid.className = 'grid';
  grid.tabIndex = 0;

  const header = document.createElement('div');
  header.className = 'grid-header';
  header.style.width = `${totalWidth}px`;
  header.append(cell('', ROWNUM_WIDTH, 'rownum'), ...result.columns.map((name, c) => cell(name, widths[c])));

  const body = document.createElement('div');
  body.className = 'grid-body';
  body.style.width = `${totalWidth}px`;
  body.style.height = `${result.rows.length * ROW_HEIGHT}px`;

  const draw = () => {
    const first = Math.max(0, Math.floor(grid.scrollTop / ROW_HEIGHT) - OVERSCAN);
    const last = Math.min(result.rows.length, Math.ceil((grid.scrollTop + grid.clientHeight) / ROW_HEIGHT) + OVERSCAN);
    const rows: HTMLDivElement[] = [];
    for (let r = first; r < last; r++) {
      const row = document.createElement('div');
      row.className = r % 2 ? 'grid-row alt' : 'grid-row';
      row.style.top = `${r * ROW_HEIGHT}px`;
      row.append(cell(String(r + 1), ROWNUM_WIDTH, 'rownum'));
      result.rows[r].forEach((value, c) => {
        const kind = value === null ? 'null' : typeof value === 'number' ? 'number' : '';
        row.append(cell(value === null ? 'NULL' : String(value), widths[c], kind));
      });
      rows.push(row);
    }
    body.replaceChildren(...rows);
  };

  grid.append(header, body);
  grid.addEventListener('scroll', draw, { passive: true });
  new ResizeObserver(draw).observe(grid);
  host.replaceChildren(grid);
  draw();
}
