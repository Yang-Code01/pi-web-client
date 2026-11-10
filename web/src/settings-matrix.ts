/**
 * #284 设置矩阵与保存 diff 的纯数据层：把 settingFields() 和两份 settings.json 合成对照行，
 * 并把「打开时的快照 vs 表单草稿」折成只含改动的 patch。DOM 不在这里，方便单测。
 */
import { tr } from "./i18n/index.ts";

/** settings.json 的扁平视图：键是 `compaction.reserveTokens` 这种点号键。 */
export type SettingsJson = Record<string, unknown>;

/**
 * settings.json 拍平成点号键：diffPatch 只认这种形状，嵌套对象在这里折开，数组整格保留。
 * 空对象不落键（「文件里没有这个对象」和「空对象」在设置里是同一件事）。
 */
export function flattenSettings(json: SettingsJson | null | undefined): SettingsJson {
  const out: SettingsJson = {};
  const walk = (value: unknown, prefix: string): void => {
    if (value === null || typeof value !== "object") {
      if (prefix) out[prefix] = value;
      return;
    }
    if (Array.isArray(value)) {
      if (prefix) out[prefix] = value;
      return;
    }
    for (const [key, child] of Object.entries(value as SettingsJson)) {
      walk(child, prefix ? `${prefix}.${key}` : key);
    }
  };
  if (json) walk(json, "");
  return out;
}

/** 与 settingFields() 的 kind 同一套取值。 */
export type SettingKind = "text" | "number" | "bool" | "select" | "list" | "model";

/** 生效值来自哪一层；`default` 包括 pi 自己的默认值与「都没有」。 */
export type SettingSource = "project" | "global" | "default";

/** buildMatrix 只读这些字段，形状与 settingFields() 的元素兼容。 */
export type MatrixField = {
  key: string;
  label: string;
  kind: SettingKind;
  group?: string;
  globalOnly?: boolean;
  advanced?: boolean;
  defaultText?: string;
};

export type MatrixRow = {
  key: string;
  label: string;
  group: string;
  kind: SettingKind;
  global: unknown;
  project: unknown;
  effective: unknown;
  source: SettingSource;
  globalOnly: boolean;
  advanced: boolean;
  /** 列表字段两层都有值：展示上标「合并」，但 effective 不伪造合并结果。 */
  merge?: boolean;
};

/** 模型在文件里是一对键，矩阵行里当一格看。 */
export type ModelValue = { provider: string; model: string };

/** settings.json 里的一格：叶子、数组或嵌套对象。 */
type SettingCell = string | number | boolean | null | undefined | SettingCell[] | SettingCellMap;
type SettingCellMap = { [key: string]: SettingCell };

function readPath(source: SettingsJson | null | undefined, key: string): SettingCell {
  // JSON 来自磁盘，这里按「一格」解释；取不到就是 undefined。
  let value = (source ?? undefined) as SettingCell;
  for (const part of key.split(".")) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as SettingCellMap)[part];
  }
  return value;
}

/** 与现有 fmtSetting 一致：空串和 null 都算没设置。 */
function isSet(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function readValue(key: string, kind: SettingKind, json: SettingsJson | null | undefined): SettingCell {
  if (kind === "model") return modelOf(json);
  const value = readPath(json, key);
  return isSet(value) ? value : undefined;
}

/** 只有 provider 和 model 都写了才算设置了一对；半截配置跟没写一样。 */
function modelOf(json: SettingsJson | null | undefined): ModelValue | undefined {
  const provider = readPath(json, "defaultProvider");
  const model = readPath(json, "defaultModel");
  if (!isSet(provider) || !isSet(model)) return undefined;
  return { provider: String(provider), model: String(model) };
}

export function effectiveOf(
  key: string,
  kind: SettingKind,
  globalJson: SettingsJson | null | undefined,
  projectJson: SettingsJson | null | undefined,
  defaults: SettingsJson | null | undefined,
): { value: SettingCell; source: SettingSource } {
  const read = (json: SettingsJson | null | undefined): SettingCell =>
    readValue(key, kind, json);

  const project = read(projectJson);
  if (project !== undefined) return { value: project, source: "project" };
  const global = read(globalJson);
  if (global !== undefined) return { value: global, source: "global" };
  return { value: read(defaults), source: "default" };
}

export function buildMatrix(
  fields: readonly MatrixField[],
  globalJson: SettingsJson | null | undefined,
  projectJson: SettingsJson | null | undefined,
  defaults: SettingsJson | null | undefined,
): MatrixRow[] {
  const rows: MatrixRow[] = [];
  let group = "";
  for (const field of fields) {
    if (field.group) group = field.group;
    const global = readValue(field.key, field.kind, globalJson);
    const project = field.globalOnly ? undefined : readValue(field.key, field.kind, projectJson);
    const { value, source } = effectiveOf(
      field.key,
      field.kind,
      globalJson,
      field.globalOnly ? null : projectJson,
      defaults,
    );
    rows.push({
      key: field.key,
      label: field.label,
      group: group || tr("其他"),
      kind: field.kind,
      global,
      project,
      effective: value,
      source,
      globalOnly: Boolean(field.globalOnly),
      advanced: Boolean(field.advanced),
      ...(field.kind === "list" && global !== undefined && project !== undefined
        ? { merge: true }
        : {}),
    });
  }
  return rows;
}

function isModelValue(value: SettingCell): value is ModelValue {
  return (
    Boolean(value) &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as ModelValue).provider === "string" &&
    typeof (value as ModelValue).model === "string"
  );
}

/**
 * 一格显示成什么。要显示哪一层的值由 effectiveOf / 调用方先算好，这里不挑来源。
 */
export function formatCell(kind: SettingKind, value: SettingCell): string {
  if (value === undefined || value === null || value === "") return "";
  if (kind === "model") return isModelValue(value) ? `${value.provider}/${value.model}` : "";
  if (kind === "bool") return value === true ? tr("开") : tr("关");
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (typeof value === "object") return "";
  return String(value);
}

/** 空输入框里那行灰字：这一格不写，保存后会落到哪一层。 */
export function inheritText(
  kind: SettingKind,
  source: SettingSource,
  value: SettingCell,
  field: MatrixField,
): string {
  if (source === "project") return "";
  const text = formatCell(kind, value);
  if (source === "global") return text ? tr("继承全局 · {p1}", { p1: text }) : "";
  if (text) return tr("继承 pi 默认 · {p1}", { p1: text });
  return field.defaultText ? tr("默认 · {p1}", { p1: field.defaultText }) : tr("默认|继承");
}

function sameCell(a: SettingCell, b: SettingCell): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => sameCell(item, b[index]));
  }
  if (a && b && typeof a === "object" && typeof b === "object") {
    const keys = Object.keys(a);
    if (keys.length !== Object.keys(b).length) return false;
    return keys.every(
      (key) => Object.prototype.hasOwnProperty.call(b, key) && sameCell(a[key], b[key]),
    );
  }
  return false;
}

/** 空串按未设置：patch 里用 null 表示「回到继承」，与 settings.set 的约定一致。 */
function emptyToNull(value: SettingCell): SettingCell {
  return value === "" || value === undefined ? null : value;
}

/**
 * 只把变了的键折进 patch。`snapshot` / `draft` 都是扁平的点号键；模型字段是一对键，
 * 任一边变了就两个键一起发，避免只写半个 provider/model。
 */
export function diffPatch(
  snapshot: SettingsJson | null | undefined,
  draft: SettingsJson | null | undefined,
  fields: readonly MatrixField[],
): Record<string, unknown | null> {
  const patch: Record<string, unknown | null> = {};
  const at = (json: SettingsJson | null | undefined, key: string): SettingCell =>
    json && Object.prototype.hasOwnProperty.call(json, key)
      ? (json[key] as SettingCell)
      : undefined;

  for (const field of fields) {
    if (field.kind === "model") {
      const provider = emptyToNull(at(draft, "defaultProvider"));
      const model = emptyToNull(at(draft, "defaultModel"));
      if (
        sameCell(emptyToNull(at(snapshot, "defaultProvider")), provider) &&
        sameCell(emptyToNull(at(snapshot, "defaultModel")), model)
      ) {
        continue;
      }
      patch.defaultProvider = provider;
      patch.defaultModel = model;
      continue;
    }

    const next = emptyToNull(at(draft, field.key));
    if (sameCell(emptyToNull(at(snapshot, field.key)), next)) continue;
    patch[field.key] = next;
  }
  return patch;
}
