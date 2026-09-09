export function text(id: string, value: unknown) {
  const node = document.querySelector(`#${id}`);
  if (node) node.textContent = String(value ?? "--");
}

export function modeLabel(
  capabilities:
    | { width: number; height: number; fps: number; pixel_format: string }[]
    | undefined,
  field: string,
) {
  const mode = capabilities?.[0];
  if (!mode) return "--";
  if (field === "resolution") return `${mode.width} × ${mode.height}`;
  if (field === "fps") return `${Number(mode.fps).toFixed(2)} fps`;
  return mode.pixel_format;
}

export function formatBytes(value: unknown) {
  if (value === null || value === undefined) return "--";
  const size = Number(value);
  if (!Number.isFinite(size) || size < 0) return "--";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = size;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 100 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

export function compact(values: unknown[], separator = " · ") {
  return (
    values
      .filter(
        (value) =>
          value !== null && value !== undefined && String(value).trim() !== "",
      )
      .join(separator) || "--"
  );
}
