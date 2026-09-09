import { z } from "zod";
const txt = z
  .string()
  .trim()
  .max(512)
  .nullish()
  .transform((v) => v || null);
const required = z.string().trim().min(1).max(512);
const num = z
  .number()
  .int()
  .nonnegative()
  .nullish()
  .transform((v) => v ?? null);
const bool = z
  .boolean()
  .nullish()
  .transform((v) => v ?? null);
const list = <T extends z.ZodType>(schema: T) =>
  z
    .array(schema)
    .max(32)
    .nullish()
    .transform((v) => v ?? []);
const partition = z.object({
  number: num,
  name: txt,
  label: txt,
  filesystem: txt,
  type: txt,
  size_bytes: num,
  free_bytes: num,
  is_boot: bool,
  is_system: bool,
  is_hidden: bool,
});
const volume = z.object({
  name: required,
  label: txt,
  filesystem: txt,
  size_bytes: num,
  free_bytes: num,
});
export const hostSchema = z.object({
  schema_version: z.literal(1),
  collected_at: required,
  hostname: required,
  os: z.object({
    name: required,
    version: txt,
    build: txt,
    architecture: txt,
    last_boot: txt,
  }),
  system: z.object({ manufacturer: txt, model: txt }).prefault({}),
  bios: z
    .object({
      manufacturer: txt,
      version: txt,
      release_date: txt,
      secure_boot: z
        .unknown()
        .optional()
        .transform((v) => (typeof v === "boolean" ? v : null)),
    })
    .prefault({}),
  cpu: z
    .object({
      model: txt,
      physical_cores: num,
      logical_processors: num,
      max_clock_mhz: num,
    })
    .prefault({}),
  memory: z
    .object({
      total_bytes: num,
      modules: list(
        z.object({
          capacity_bytes: num,
          speed_mts: num,
          manufacturer: txt,
          part_number: txt,
        }),
      ),
    })
    .prefault({}),
  gpus: list(
    z.object({ name: required, driver_version: txt, memory_bytes: num }),
  ),
  disks: list(
    z.object({
      number: num,
      model: required,
      interface: txt,
      partition_style: txt,
      health: txt,
      operational_status: txt,
      size_bytes: num,
      allocated_bytes: num,
      partitions: list(partition),
    }),
  ),
  volumes: list(volume),
  network: z.object({ addresses: list(required) }).prefault({}),
});

export type HostInfo = z.infer<typeof hostSchema>;
