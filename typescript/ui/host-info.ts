import type { HostInfo } from "../src/host-schema.js";
type HostReport = { status: string; message: string; data: HostInfo | null };
import { text, compact, formatBytes } from "./formatting.js";
function renderHostStorage(host: NonNullable<HostReport["data"]>) {
  const container = document.querySelector<HTMLElement>("#host-storage");
  if (!container) return;
  container.replaceChildren();
  const disks = host.disks || [];
  const hasMappedPartitions = disks.some(
    (disk) => (disk.partitions || []).length > 0,
  );

  disks.forEach((disk, index) => {
    const card = document.createElement("article");
    card.className = "storage-card";
    const title = document.createElement("strong");
    title.textContent = `磁盘 ${disk.number ?? index} · ${disk.model}`;
    const detail = document.createElement("span");
    detail.textContent = compact([
      formatBytes(disk.size_bytes),
      disk.interface,
      disk.partition_style,
      disk.health,
    ]);
    card.append(title, detail);

    if ((disk.partitions || []).length > 0) {
      const partitionList = document.createElement("div");
      partitionList.className = "storage-partitions";
      for (const partition of disk.partitions) {
        const row = document.createElement("div");
        row.className = "storage-partition";
        const name = document.createElement("b");
        name.textContent = partition.name || `分区 ${partition.number ?? "--"}`;
        const flags = compact([
          partition.label,
          partition.filesystem,
          partition.type,
          partition.is_system ? "系统" : null,
          partition.is_boot ? "启动" : null,
          partition.is_hidden ? "隐藏" : null,
        ]);
        const capacity =
          partition.free_bytes == null
            ? `${formatBytes(partition.size_bytes)} 总计`
            : `${formatBytes(partition.free_bytes)} 可用 / ${formatBytes(partition.size_bytes)} 总计`;
        const summary = document.createElement("span");
        summary.textContent = `${flags}\n${capacity}`;
        row.append(name, summary);
        partitionList.append(row);
      }
      card.append(partitionList);
    }
    container.append(card);
  });

  if (!hasMappedPartitions && (host.volumes || []).length > 0) {
    const card = document.createElement("article");
    card.className = "storage-card";
    const title = document.createElement("strong");
    title.textContent = "已挂载分区";
    const partitionList = document.createElement("div");
    partitionList.className = "storage-partitions";
    for (const volume of host.volumes) {
      const row = document.createElement("div");
      row.className = "storage-partition";
      const name = document.createElement("b");
      name.textContent = volume.name;
      const summary = document.createElement("span");
      summary.textContent = `${compact([volume.label, volume.filesystem])}\n${formatBytes(volume.free_bytes)} 可用 / ${formatBytes(volume.size_bytes)} 总计`;
      row.append(name, summary);
      partitionList.append(row);
    }
    card.append(title, partitionList);
    container.append(card);
  }

  if (!container.hasChildNodes()) container.textContent = "--";
}

export function updateHostInfo(report: HostReport) {
  const state = document.querySelector<HTMLElement>("#host-info-state");
  const list = document.querySelector<HTMLElement>("#host-info-list");
  if (!state || !list) return;
  const available = report?.status === "available" && report.data;
  state.classList.toggle("error", report?.status === "error");
  state.textContent = available
    ? "已同步"
    : report?.status === "error"
      ? "数据错误"
      : "未连接";
  text("host-info-message", report?.message || "尚未收到被控主机信息");
  list.hidden = !available;
  if (!available) return;

  const host = report.data;
  if (!host) return;
  text(
    "host-collected-at",
    host.collected_at ? new Date(host.collected_at).toLocaleString() : "--",
  );
  text("host-name", host.hostname);
  text(
    "host-os",
    compact([
      host.os?.name,
      host.os?.version,
      host.os?.build ? `Build ${host.os.build}` : null,
      host.os?.architecture,
    ]),
  );
  text("host-system", compact([host.system?.manufacturer, host.system?.model]));
  text(
    "host-bios",
    compact([
      host.bios?.manufacturer,
      host.bios?.version,
      host.bios?.secure_boot == null
        ? null
        : `安全启动 ${host.bios?.secure_boot ? "开启" : "关闭"}`,
    ]),
  );
  text(
    "host-cpu",
    compact([
      host.cpu?.model,
      host.cpu?.max_clock_mhz ? `${host.cpu.max_clock_mhz} MHz` : null,
    ]),
  );
  text(
    "host-cores",
    compact([
      host.cpu?.physical_cores == null ? null : `${host.cpu.physical_cores} 核`,
      host.cpu?.logical_processors == null
        ? null
        : `${host.cpu.logical_processors} 线程`,
    ]),
  );
  text(
    "host-gpu",
    (host.gpus || [])
      .map((gpu) =>
        compact([
          gpu.name,
          gpu.driver_version ? `驱动 ${gpu.driver_version}` : null,
        ]),
      )
      .join("\n") || "--",
  );
  text("host-memory", formatBytes(host.memory?.total_bytes));
  const speeds = [
    ...new Set(
      (host.memory?.modules || [])
        .map((module) => module.speed_mts)
        .filter(Boolean),
    ),
  ];
  text(
    "host-memory-speed",
    speeds.length ? speeds.map((speed) => `${speed} MT/s`).join("、") : "--",
  );
  renderHostStorage(host);
  text("host-addresses", (host.network?.addresses || []).join("\n") || "--");
}
