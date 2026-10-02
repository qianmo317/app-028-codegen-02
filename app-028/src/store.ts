/** 全局状态（Vue 自带 ref / computed / watch，不引入任何状态库） */
import { computed, ref, watch } from 'vue'
import {
  BUILTIN_PAPERS,
  BUILTIN_PHOTO_SIZES,
  BUILTIN_TEMPLATES,
  groupsFromTask,
  newId,
  optionsFromTask,
  resolvePaper,
} from './logic/library'
import { pack, sheetsFromPlacements } from './logic/packer'
import { loadJSON, saveJSON } from './logic/storage'
import {
  allocationsFromPlan,
  batchTotalSheets,
  isValidDateStr,
  planFifo,
  specKey,
  todayStr,
} from './logic/inventory'
import type {
  Leftover,
  Paper,
  PaperBatch,
  PaperTemplate,
  PhotoRef,
  PhotoSize,
  Placement,
  Settings,
  Sheet,
  StockConsumption,
  Task,
} from './logic/types'

const KEY = {
  customPapers: 'ppis.customPapers.v1',
  customSizes: 'ppis.customSizes.v1',
  settings: 'ppis.settings.v1',
  tasks: 'ppis.tasks.v1',
  leftovers: 'ppis.leftovers.v1',
  batches: 'ppis.batches.v1',
  consumptions: 'ppis.consumptions.v1',
}

export const DEFAULT_SETTINGS: Settings = {
  gapMm: 0,
  kerfMm: 0.5,
  safeEdgeMm: 3,
  allowRotate: true,
  exportDpi: 300,
}

export const customPapers = ref<Paper[]>(loadJSON<Paper[]>(KEY.customPapers, []))
export const customSizes = ref<PhotoSize[]>(loadJSON<PhotoSize[]>(KEY.customSizes, []))
export const settings = ref<Settings>({ ...DEFAULT_SETTINGS, ...loadJSON(KEY.settings, {}) })
export const tasks = ref<Task[]>(loadJSON<Task[]>(KEY.tasks, []))
export const leftovers = ref<Leftover[]>(loadJSON<Leftover[]>(KEY.leftovers, []))
export const batches = ref<PaperBatch[]>(loadJSON<PaperBatch[]>(KEY.batches, []))
export const consumptions = ref<StockConsumption[]>(loadJSON<StockConsumption[]>(KEY.consumptions, []))

watch(customPapers, (v) => saveJSON(KEY.customPapers, v), { deep: true, flush: "sync" })
watch(customSizes, (v) => saveJSON(KEY.customSizes, v), { deep: true, flush: "sync" })
watch(settings, (v) => saveJSON(KEY.settings, v), { deep: true, flush: "sync" })
watch(tasks, (v) => saveJSON(KEY.tasks, v), { deep: true, flush: "sync" })
watch(leftovers, (v) => saveJSON(KEY.leftovers, v), { deep: true, flush: "sync" })
watch(batches, (v) => saveJSON(KEY.batches, v), { deep: true, flush: "sync" })
watch(consumptions, (v) => saveJSON(KEY.consumptions, v), { deep: true, flush: "sync" })

export const allPapers = computed<Paper[]>(() => [...BUILTIN_PAPERS, ...customPapers.value])
export const allSizes = computed<PhotoSize[]>(() => [...BUILTIN_PHOTO_SIZES, ...customSizes.value])
export const templates = computed<PaperTemplate[]>(() => BUILTIN_TEMPLATES)

/** 照片文件只在本机内存里保留，绝不写入存储、绝不上传 */
const photoCache = new Map<string, { url: string; ref: PhotoRef }>()
/** 内存照片变化计数（Map 本身不是响应式的，用它触发重绘） */
export const photoVersion = ref(0)

export function photoKey(itemId: string, copyIndex: number): string {
  return `${itemId}#${copyIndex}`
}

export function setItemPhoto(key: string, url: string, ref: PhotoRef): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.set(key, { url, ref })
  photoVersion.value++
}

export function getItemPhoto(key: string): { url: string; ref: PhotoRef } | undefined {
  return photoCache.get(key)
}

export function clearItemPhoto(key: string): void {
  const old = photoCache.get(key)
  if (old) URL.revokeObjectURL(old.url)
  photoCache.delete(key)
  photoVersion.value++
}

/** 每张照片（placement）对应第几张底片 */
export function copyIndexMap(sheets: Sheet[]): Map<number, number> {
  const counter = new Map<string, number>()
  const out = new Map<number, number>()
  for (const s of sheets) {
    for (const p of s.placements) {
      const n = counter.get(p.itemId) ?? 0
      out.set(p.seq, n)
      counter.set(p.itemId, n + 1)
    }
  }
  return out
}

/** placement -> 本机照片（key + objectURL），未导入照片时返回 undefined */
export function makePhotoResolver(task: Task, sheets: Sheet[]) {
  const map = copyIndexMap(sheets)
  const repeat = new Map(task.items.map((i) => [i.id, i.repeatSamePhoto]))
  return (p: Placement): { key: string; url: string } | undefined => {
    const ci = repeat.get(p.itemId) === false ? map.get(p.seq) ?? 0 : 0
    const k = photoKey(p.itemId, ci)
    const ph = getItemPhoto(k)
    return ph ? { key: k, url: ph.url } : undefined
  }
}

/** 生成「placement -> 本机缩略图 URL」的解析函数 */
export function makeThumbResolver(task: Task, sheets: Sheet[]) {
  const resolve = makePhotoResolver(task, sheets)
  return (p: Placement): string | undefined => resolve(p)?.url
}

export function getTask(id: string): Task | undefined {
  return tasks.value.find((t) => t.id === id)
}

export function createTask(partial: Partial<Task> = {}): Task {
  const task: Task = {
    id: newId('task'),
    name: partial.name ?? `拼版任务 ${tasks.value.length + 1}`,
    paperId: partial.paperId ?? 'p5x7',
    customPaper: partial.customPaper,
    items: partial.items ?? [],
    gapMm: partial.gapMm ?? settings.value.gapMm,
    kerfMm: partial.kerfMm ?? settings.value.kerfMm,
    safeEdgeMm: partial.safeEdgeMm ?? settings.value.safeEdgeMm,
    allowRotate: partial.allowRotate ?? settings.value.allowRotate,
    headerText: partial.headerText ?? '',
    footerText: partial.footerText ?? '',
    createdAt: Date.now(),
  }
  tasks.value.unshift(task)
  return task
}

/** 删除任务：若已扣减库存，先把纸还回批次（void 留痕） */
export function deleteTask(id: string): void {
  voidConsumptionsOfTask(id, '任务已删除，库存自动还回')
  tasks.value = tasks.value.filter((t) => t.id !== id)
}

export function touch(): void {
  tasks.value = tasks.value.slice()
}

/**
 * 执行排样；返回错误提示（无错误时返回 undefined）。
 * 任务此前已过账扣减过库存时，重排会先把已扣的批次还回（void 留痕），
 * 由排样页按新张数重新走「扣减库存」——一笔消耗只能扣一次。
 */
export function runPack(task: Task): string | undefined {
  const paper = resolvePaper(task, allPapers.value)
  const groups = groupsFromTask(task, allSizes.value)
  if (!groups.length) {
    task.result = undefined
    return '照片清单为空，请先添加照片尺寸与数量'
  }
  const out = pack(groups, optionsFromTask(task, paper))
  if (out.error) {
    task.result = undefined
    return out.error
  }
  // 重排：先还回此前已扣的库存
  voidConsumptionsOfTask(task.id, '排样已重排，原扣减自动还回，请按新张数重新扣减')
  task.result = out.result
  task.manual = undefined
  // 只在任务第一次排样成功时锁定「排样当时估的张数」，供月底对账
  if (task.initialSheetCount === undefined) task.initialSheetCount = out.result.sheets.length
  touch()
  return undefined
}

/** 当前生效的相纸版面：手工微调优先于自动排样 */
export function sheetsOf(task: Task): Sheet[] {
  if (task.manual) {
    const paper = resolvePaper(task, allPapers.value)
    const count = Math.max(1, task.result?.sheets.length ?? 1)
    return sheetsFromPlacements(task.manual.placements, optionsFromTask(task, paper), count).sheets
  }
  return task.result?.sheets ?? []
}

export function manualPlacementsOf(task: Task): Placement[] {
  if (task.manual) return task.manual.placements
  return (task.result?.sheets ?? []).flatMap((s) => s.placements)
}

/** 写入手工微调结果并做增量校验（不重新排样） */
export function setManual(task: Task, placements: Placement[]): void {
  const paper = resolvePaper(task, allPapers.value)
  const count = Math.max(1, task.result?.sheets.length ?? 1)
  const t0 = performance.now()
  const { sheets, errors } = sheetsFromPlacements(placements, optionsFromTask(task, paper), count)
  const ms = performance.now() - t0
  const stepCount = sheets.reduce((acc, s) => acc + s.cutSteps.length, 0)
  task.manual = {
    placements,
    valid: errors.length === 0,
    message: errors.length
      ? errors[0]
      : `guillotine 校验通过：${stepCount} 刀全部贯通，用时 ${ms.toFixed(1)}ms`,
    validationMs: Math.round(ms * 100) / 100,
    stepCount,
  }
  touch()
}

export function resetManual(task: Task): void {
  task.manual = undefined
  touch()
}

export function addCustomPaper(p: Omit<Paper, 'id'>): Paper {
  const paper: Paper = { ...p, id: newId('paper') }
  customPapers.value = [...customPapers.value, paper]
  return paper
}

export function addCustomSize(s: Omit<PhotoSize, 'id'>): PhotoSize {
  const size: PhotoSize = { ...s, id: newId('size') }
  customSizes.value = [...customSizes.value, size]
  return size
}

export function removeCustomPaper(id: string): void {
  customPapers.value = customPapers.value.filter((p) => p.id !== id)
}

export function removeCustomSize(id: string): void {
  customSizes.value = customSizes.value.filter((s) => s.id !== id)
}

export function addLeftover(l: Omit<Leftover, 'id' | 'createdAt' | 'usedCount'>): Leftover {
  const item: Leftover = {
    ...l,
    id: newId('leftover'),
    createdAt: Date.now(),
    usedCount: 0,
  }
  leftovers.value = [item, ...leftovers.value]
  return item
}

export function removeLeftover(id: string): void {
  leftovers.value = leftovers.value.filter((l) => l.id !== id)
}

export function markLeftoverUsed(id: string): void {
  leftovers.value = leftovers.value.map((l) =>
    l.id === id ? { ...l, usedCount: l.usedCount + 1 } : l,
  )
}

/* ===================== 库存台账 ===================== */

function nextBatchCode(): string {
  const prefix = todayStr().slice(0, 7).replace('-', '')
  const n =
    batches.value.filter((b) => b.code.startsWith(prefix)).length + 1
  return `${prefix}-${String(n).padStart(2, '0')}`
}

export function addBatch(
  input: Omit<PaperBatch, 'id' | 'code'> & { code?: string },
): PaperBatch {
  const batch: PaperBatch = {
    ...input,
    id: newId('batch'),
    code: input.code?.trim() || nextBatchCode(),
  }
  batches.value = [...batches.value, batch]
  return batch
}

export function removeBatch(id: string): void {
  batches.value = batches.value.filter((b) => b.id !== id)
}

/** 该任务当前已过账（库存已扣、未还回）的消耗 */
export function postedConsumptionOfTask(taskId: string): StockConsumption | undefined {
  return consumptions.value.find((c) => c.taskId === taskId && c.status === 'posted')
}

export interface PostResult {
  consumption?: StockConsumption
  error?: string
}

/**
 * 按 FIFO 过账一笔消耗：从最早批次扣减，记录各批分别的成本。
 * 一笔任务只能有一条 posted 消耗（只扣一次）；库存不足时拒绝并返回原因。
 */
export function postConsumption(args: {
  task: Task
  sheets: number
  date?: string
}): PostResult {
  const { task, sheets } = args
  const existing = postedConsumptionOfTask(task.id)
  if (existing) {
    return { error: '该任务已扣减过库存（一笔消耗只能扣一次）；如需调整请先「还回」再重新扣减' }
  }
  const paper = resolvePaper(task, allPapers.value)
  const date = args.date ?? todayStr()
  if (!isValidDateStr(date)) {
    return { error: `消耗日期「${date}」格式应为 YYYY-MM-DD` }
  }
  const plan = planFifo(batches.value, consumptions.value, paper.wMm, paper.hMm, paper.kind, sheets, {
    atDate: date,
  })
  if (plan.error) return { error: plan.error }
  const c: StockConsumption = {
    id: newId('use'),
    taskId: task.id,
    taskName: task.name,
    paperName: paper.name,
    wMm: paper.wMm,
    hMm: paper.hMm,
    kind: paper.kind,
    date,
    estimatedSheets: task.initialSheetCount ?? sheets,
    actualSheets: plan.totalSheets,
    actualCostCents: plan.totalCostCents,
    allocations: allocationsFromPlan(plan),
    status: 'posted',
    createdAt: Date.now(),
  }
  consumptions.value = [...consumptions.value, c]
  return { consumption: c }
}

/** 手工还回一笔已扣消耗（重排/取消用纸时使用） */
export function voidConsumption(id: string, reason = '手工还回库存'): void {
  consumptions.value = consumptions.value.map((c) =>
    c.id === id && c.status === 'posted'
      ? { ...c, status: 'void', voidedAt: Date.now(), voidReason: reason }
      : c,
  )
}

/** 还回某任务全部已过账消耗（删除任务 / 重排前自动调用） */
export function voidConsumptionsOfTask(taskId: string, reason: string): void {
  if (!consumptions.value.some((c) => c.taskId === taskId && c.status === 'posted')) return
  const now = Date.now()
  consumptions.value = consumptions.value.map((c) =>
    c.taskId === taskId && c.status === 'posted'
      ? { ...c, status: 'void', voidedAt: now, voidReason: reason }
      : c,
  )
}

/** 规格 -> 当前库存总张数（用于排样页提示够不够用） */
export function stockForPaper(wMm: number, hMm: number, kind: 'sheet' | 'roll'): number {
  const key = specKey(wMm, hMm, kind)
  const used = new Map<string, number>()
  for (const c of consumptions.value) {
    if (c.status !== 'posted') continue
    for (const a of c.allocations) used.set(a.batchId, (used.get(a.batchId) ?? 0) + a.sheets)
  }
  return batches.value
    .filter((b) => specKey(b.wMm, b.hMm, b.kind) === key)
    .reduce((acc, b) => acc + batchTotalSheets(b) - (used.get(b.id) ?? 0), 0)
}

