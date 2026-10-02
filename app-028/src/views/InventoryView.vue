<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import {
  allPapers,
  batches,
  consumptions,
  addBatch,
  removeBatch,
  voidConsumption,
} from '../store'
import {
  UNIT_LABEL,
  batchBalances,
  batchColorOf,
  batchLedgerRows,
  batchTotalSheets,
  costDetailRows,
  daysToExpire,
  isValidDateStr,
  monthEndStr,
  monthStartStr,
  periodReport,
  specKey,
  specLabel,
  todayStr,
  urgentBatches,
} from '../logic/inventory'
import { csvBlob } from '../logic/csv'
import { downloadBlob } from '../logic/image'
import type { PaperBatch, StockUnit } from '../logic/types'

/* ---------- 时间段 & 时点 ---------- */
const today = todayStr()
const periodFrom = ref(monthStartStr(today))
const periodTo = ref(monthEndStr(today))
const atDate = ref(today)
const warnDays = ref(30)

/* ---------- 入库表单 ---------- */
const form = reactive({
  code: '',
  paperId: 'p5x7',
  customName: '',
  customW: 127,
  customH: 178,
  inDate: today,
  expireDate: '',
  unit: 'pack' as StockUnit,
  units: 5,
  sheetsPerUnit: 100,
  priceYuan: 80,
  note: '',
})

const formError = ref('')
const formOk = ref('')

const selectedPaper = computed(() => allPapers.value.find((p) => p.id === form.paperId))

/** 登记这批的规格（跟随相纸库选择；「手填规格」时取自定义宽高） */
function resolveSpec(): { name: string; w: number; h: number; kind: 'sheet' | 'roll' } | undefined {
  if (form.paperId === 'manual') {
    if (!form.customName.trim()) return undefined
    if (!(form.customW > 0) || !(form.customH > 0)) return undefined
    return {
      name: form.customName.trim(),
      w: form.customW,
      h: form.customH,
      kind: form.unit === 'roll' ? 'roll' : 'sheet',
    }
  }
  const p = selectedPaper.value
  if (!p) return undefined
  return { name: p.name, w: p.wMm, h: p.hMm, kind: p.kind }
}

/** 选了卷筒相纸时，入库单位自动跟随 */
function onPaperChange() {
  const p = selectedPaper.value
  if (p?.kind === 'roll' && form.unit !== 'roll') {
    form.unit = 'roll'
    form.sheetsPerUnit = Math.round(p.hMm / 152) || 20
  }
}

function submitBatch() {
  formError.value = ''
  formOk.value = ''
  const spec = resolveSpec()
  if (!spec) {
    formError.value = '请选择有效规格，或手填规格名称与正数宽高'
    return
  }
  if (!isValidDateStr(form.inDate)) {
    formError.value = '入库日期格式应为 YYYY-MM-DD'
    return
  }
  if (form.expireDate && !isValidDateStr(form.expireDate)) {
    formError.value = '有效期格式应为 YYYY-MM-DD（或留空）'
    return
  }
  if (!(form.units > 0)) {
    formError.value = '入库数量必须大于 0（包数 / 卷数 / 散张数）'
    return
  }
  if (form.unit !== 'sheets' && !(form.sheetsPerUnit > 0)) {
    formError.value = '每包/每卷折合张数必须大于 0'
    return
  }
  if (!(form.priceYuan >= 0)) {
    formError.value = '采购单价不能为负'
    return
  }
  const b = addBatch({
    code: form.code,
    paperName: spec.name,
    wMm: spec.w,
    hMm: spec.h,
    kind: spec.kind,
    inDate: form.inDate,
    expireDate: form.expireDate,
    units: form.units,
    unit: form.unit,
    sheetsPerUnit: form.unit === 'sheets' ? 1 : form.sheetsPerUnit,
    priceCents: Math.round(form.priceYuan * 100),
    note: form.note,
  })
  formOk.value = `已登记批次 ${b.code}：${specLabel(b.wMm, b.hMm, b.kind)}，共 ${batchTotalSheets(b)} 张`
  form.code = ''
  form.note = ''
}

/* ---------- 台账数据 ---------- */
const periodInvalid = computed(
  () => !isValidDateStr(periodFrom.value) || !isValidDateStr(periodTo.value) || periodFrom.value > periodTo.value,
)
const atDateInvalid = computed(() => !isValidDateStr(atDate.value))

const balances = computed(() =>
  atDateInvalid.value
    ? []
    : batchBalances(batches.value, consumptions.value, {
        atDate: atDate.value,
        today,
        warnDays: warnDays.value,
      }),
)

const urgent = computed(() => urgentBatches(balances.value))

const totalRemainingSheets = computed(() => balances.value.reduce((a, x) => a + x.remaining, 0))
const totalRemainingCost = computed(() => balances.value.reduce((a, x) => a + x.remainingCostCents, 0))

const statusBadge = (x: (typeof balances.value)[number]) => {
  if (x.expireStatus === 'expired') return { cls: 'danger', text: `已过期 ${-Math.round(x.expireInDays ?? 0)} 天` }
  if (x.expireStatus === 'soon') return { cls: 'warn', text: `${Math.round(x.expireInDays ?? 0)} 天后到期` }
  if (x.expireStatus === 'ok') return { cls: 'ok', text: `剩 ${Math.round(x.expireInDays ?? 0)} 天` }
  return { cls: '', text: '—' }
}

function expireText(b: PaperBatch): string {
  const d = daysToExpire(b.expireDate, today)
  if (d === null) return '—'
  if (d < 0) return `${b.expireDate}（已过期）`
  return `${b.expireDate}（${d} 天）`
}

/* ---------- 消耗流水（含已还回留痕） ---------- */
const ledgerConsumptions = computed(() =>
  periodInvalid.value
    ? []
    : [...consumptions.value]
        .filter((c) => c.date >= periodFrom.value && c.date <= periodTo.value)
        .sort((a, b) => (a.date === b.date ? b.createdAt - a.createdAt : a.date < b.date ? 1 : -1)),
)

const batchById = computed(() => new Map(batches.value.map((b) => [b.id, b])))

function allocText(c: (typeof consumptions.value)[number]): string {
  return c.allocations
    .map((a) => {
      const b = batchById.value.get(a.batchId)
      return `${b?.code ?? '批次已删'}×${a.sheets}`
    })
    .join('、')
}

function yuan(cents: number): string {
  return `¥${(cents / 100).toFixed(2)}`
}

function yuan4(cents: number): string {
  return `¥${(cents / 100).toFixed(4)}`
}

/* ---------- 时段对账报表 ---------- */
/** 规格 -> 固定单价（取相纸库里同规格最最便宜的一张价；找不到则 0） */
function fixedPriceOf(w: number, h: number, kind: 'sheet' | 'roll'): number {
  const key = specKey(w, h, kind)
  const prices = allPapers.value
    .filter((p) => specKey(p.wMm, p.hMm, p.kind) === key)
    .map((p) => p.priceCents)
  return prices.length ? Math.min(...prices) : 0
}

const report = computed(() =>
  periodInvalid.value
    ? periodReport(batches.value, [], periodFrom.value, periodTo.value, fixedPriceOf)
    : periodReport(batches.value, consumptions.value, periodFrom.value, periodTo.value, fixedPriceOf),
)

/** 本时段消耗涉及到的批次顺序（给色带配色） */
const usedBatchIds = computed(() => {
  const ids: string[] = []
  for (const r of report.value.rows) {
    for (const { a } of r.allocations) if (!ids.includes(a.batchId)) ids.push(a.batchId)
  }
  return ids
})

function colorOf(batchId: string): string {
  return batchColorOf(usedBatchIds.value, batchId)
}

/* ---------- 导出 ---------- */
function exportCostCsv() {
  if (periodInvalid.value) return
  const rows = costDetailRows(report.value)
  downloadBlob(csvBlob(rows), `相纸成本清单-${periodFrom.value}_${periodTo.value}.csv`)
}

function exportLedgerCsv() {
  if (atDateInvalid.value) return
  const rows = batchLedgerRows(balances.value, atDate.value)
  downloadBlob(csvBlob(rows), `相纸库存台账-截至${atDate.value}.csv`)
}

function fmtSigned(cents: number): string {
  const v = cents / 100
  return `${v >= 0 ? '+' : '-'}¥${Math.abs(v).toFixed(2)}`
}
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">相纸库存台账</h1>
      <span class="badge brand">批次进价 · FIFO 先进先出 · 实际批次成本</span>
      <div class="spacer"></div>
    </div>

    <!-- 顶部总览 -->
    <div class="grid cols-4">
      <div class="card">
        <div class="card-sub">截至 {{ atDate }} 总结余</div>
        <div style="font-size: 22px; font-weight: 700; font-family: var(--font-mono)">{{ totalRemainingSheets }} 张</div>
      </div>
      <div class="card">
        <div class="card-sub">结余库存金额（按批次进价）</div>
        <div style="font-size: 22px; font-weight: 700; font-family: var(--font-mono)">{{ yuan(totalRemainingCost) }}</div>
      </div>
      <div class="card">
        <div class="card-sub">{{ periodFrom }} ~ {{ periodTo }} 实际用纸 / 花费</div>
        <div style="font-size: 18px; font-weight: 700; font-family: var(--font-mono)">
          {{ report.totalActualSheets }} 张 · {{ yuan(report.totalActualCostCents) }}
        </div>
      </div>
      <div class="card">
        <div class="card-sub">临期 / 过期批次</div>
        <div style="font-size: 18px; font-weight: 700; font-family: var(--font-mono)">
          <span :class="urgent.length ? 'text-danger' : ''">{{ urgent.length }} 批</span>
        </div>
      </div>
    </div>

    <div v-if="urgent.length" class="note warn">
      <strong>该先用：</strong>
      <span v-for="(x, i) in urgent" :key="x.batch.id">
        <strong>{{ x.batch.code }}</strong>（{{ specLabel(x.batch.wMm, x.batch.hMm, x.batch.kind) }}，
        结余 {{ x.remaining }} 张，
        <template v-if="x.expireStatus === 'expired'">已过期 {{ -Math.round(x.expireInDays ?? 0) }} 天</template>
        <template v-else>{{ Math.round(x.expireInDays ?? 0) }} 天后到期</template>）<template v-if="i < urgent.length - 1">；</template>
      </span>
    </div>

    <div class="grid sidebar">
      <div class="stack">
        <!-- 入库登记 -->
        <div class="card">
          <h3>① 入库登记（按批次）</h3>
          <div class="card-sub">一次进货好几包/几卷、每批价格不同，就各登一批；用的时候按先进先出自动取最早批次</div>
          <div class="stack">
            <div class="grid cols-2">
              <label class="field">
                相纸规格
                <select v-model="form.paperId" @change="onPaperChange">
                  <option v-for="p in allPapers" :key="p.id" :value="p.id">
                    {{ p.name }} {{ p.wMm }}×{{ p.hMm }}mm
                  </option>
                  <option value="manual">手填规格…</option>
                </select>
              </label>
              <label class="field">
                批次号（留空自动生成）
                <input v-model="form.code" type="text" placeholder="如 202610-01" />
              </label>
            </div>
            <div v-if="form.paperId === 'manual'" class="grid cols-3">
              <label class="field">
                规格名称
                <input v-model="form.customName" type="text" placeholder="如 光面 5 寸" />
              </label>
              <label class="field">
                宽 mm
                <input v-model.number="form.customW" type="number" min="1" step="0.1" />
              </label>
              <label class="field">
                高 mm（卷筒填长度）
                <input v-model.number="form.customH" type="number" min="1" step="0.1" />
              </label>
            </div>
            <div class="grid cols-3">
              <label class="field">
                入库日期
                <input v-model="form.inDate" type="text" placeholder="YYYY-MM-DD" />
              </label>
              <label class="field">
                有效期至（可空）
                <input v-model="form.expireDate" type="text" placeholder="YYYY-MM-DD" />
              </label>
              <label class="field">
                入库单位
                <select v-model="form.unit">
                  <option value="pack">包</option>
                  <option value="roll">卷</option>
                  <option value="sheets">散张</option>
                </select>
              </label>
            </div>
            <div class="grid cols-3">
              <label class="field">
                入库{{ UNIT_LABEL[form.unit] }}数
                <input v-model.number="form.units" type="number" min="0" step="1" />
              </label>
              <label class="field" v-if="form.unit !== 'sheets'">
                每{{ UNIT_LABEL[form.unit] }}折合张数
                <input v-model.number="form.sheetsPerUnit" type="number" min="1" step="1" />
              </label>
              <label class="field">
                采购单价（元/{{ UNIT_LABEL[form.unit] }}）
                <input v-model.number="form.priceYuan" type="number" min="0" step="0.01" />
              </label>
            </div>
            <label class="field">
              备注（供应商/批号等）
              <input v-model="form.note" type="text" placeholder="选填" />
            </label>
            <div class="note" v-if="form.unit !== 'sheets'">
              本批合计 {{ form.units * Math.max(1, form.sheetsPerUnit) }} 张，每张成本
              ¥{{ (form.priceYuan / Math.max(1, form.sheetsPerUnit)).toFixed(4) }}/张
            </div>
            <div v-if="formError" class="note danger">{{ formError }}</div>
            <div v-if="formOk" class="note ok">{{ formOk }}</div>
            <div class="row">
              <button class="btn primary" @click="submitBatch">登记入库</button>
            </div>
          </div>
        </div>

        <!-- 查询条件 -->
        <div class="card">
          <h3>② 时间段与时点</h3>
          <div class="grid cols-2">
            <label class="field">统计起
              <input v-model="periodFrom" type="text" placeholder="YYYY-MM-DD" />
            </label>
            <label class="field">统计止
              <input v-model="periodTo" type="text" placeholder="YYYY-MM-DD" />
            </label>
            <label class="field">查批次结余截至
              <input v-model="atDate" type="text" placeholder="YYYY-MM-DD" />
            </label>
            <label class="field">临期预警天数
              <input v-model.number="warnDays" type="number" min="1" step="1" />
            </label>
          </div>
          <div class="row" style="margin-top: 8px">
            <button class="btn small" @click="periodFrom = monthStartStr(today); periodTo = monthEndStr(today)">本月</button>
            <button class="btn small" @click="atDate = today">结余截至今天</button>
            <button class="btn small" @click="exportLedgerCsv" :disabled="atDateInvalid">导出批次台账 CSV</button>
          </div>
          <div v-if="periodInvalid" class="note danger" style="margin-top: 8px">
            统计起止日期需为合法 YYYY-MM-DD，且起 ≤ 止
          </div>
          <div v-if="atDateInvalid" class="note danger" style="margin-top: 8px">
            「结余截至」日期需为合法 YYYY-MM-DD
          </div>
        </div>
      </div>

      <div class="stack">
        <!-- 批次台账表 -->
        <div class="card">
          <h3>
            批次台账（截至 {{ atDate }}）
            <span class="row tight">
              <span class="badge">{{ balances.length }} 批</span>
              <button class="btn small" @click="exportLedgerCsv">导出 CSV</button>
            </span>
          </h3>
          <div v-if="!balances.length" class="note">还没有登记任何批次，先在左侧「入库登记」</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>批次</th>
                <th>规格</th>
                <th>入库</th>
                <th class="num">入库(张)</th>
                <th class="num">已耗</th>
                <th class="num">结余</th>
                <th class="num">进价/张</th>
                <th>有效期</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in balances" :key="x.batch.id">
                <td>
                  <span class="batch-dot" :style="{ background: colorOf(x.batch.id) }"></span>
                  <strong>{{ x.batch.code }}</strong>
                  <div class="mono dim">{{ x.batch.units }}{{ UNIT_LABEL[x.batch.unit] }}×{{ x.batch.sheetsPerUnit }}张 · {{ yuan(x.batch.priceCents) }}/{{ UNIT_LABEL[x.batch.unit] }}</div>
                </td>
                <td>{{ specLabel(x.batch.wMm, x.batch.hMm, x.batch.kind) }}<div class="dim">{{ x.batch.paperName }}</div></td>
                <td class="mono">{{ x.batch.inDate }}</td>
                <td class="num">{{ x.existsAt ? x.inSheets : 0 }}</td>
                <td class="num">{{ x.existsAt ? x.used : 0 }}</td>
                <td class="num"><strong>{{ x.existsAt ? x.remaining : 0 }}</strong></td>
                <td class="num">{{ yuan4(x.unitCostCents) }}</td>
                <td>
                  <span class="badge" :class="statusBadge(x).cls">{{ expireText(x.batch) }}</span>
                </td>
                <td>
                  <button
                    class="btn small danger"
                    :disabled="x.used > 0"
                    :title="x.used > 0 ? '该批已有消耗，不能删除' : ''"
                    @click="removeBatch(x.batch.id)"
                  >删除</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 时段对账 -->
        <div class="card">
          <h3>
            ③ 月底对账（{{ periodFrom }} ~ {{ periodTo }}）
            <button class="btn small" :disabled="periodInvalid" @click="exportCostCsv">导出成本清单 CSV（带批次）</button>
          </h3>
          <div class="grid cols-4" style="margin-bottom: 10px">
            <div class="stat"><span>实际用纸</span><strong>{{ report.totalActualSheets }} 张</strong></div>
            <div class="stat"><span>排样估算</span><strong>{{ report.totalEstimatedSheets }} 张</strong></div>
            <div class="stat">
              <span>张数差</span>
              <strong :class="report.totalVarianceSheets > 0 ? 'text-warn' : report.totalVarianceSheets < 0 ? 'text-ok' : ''">
                {{ report.totalVarianceSheets >= 0 ? '+' : '' }}{{ report.totalVarianceSheets }} 张
              </strong>
            </div>
            <div class="stat">
              <span>实际花费</span><strong>{{ yuan(report.totalActualCostCents) }}</strong>
              <div class="dim">固定单价估 {{ yuan(report.totalFixedCostCents) }}（{{ fmtSigned(report.totalVarianceCostCents) }}）</div>
            </div>
          </div>

          <div v-if="!report.rows.length" class="note">该时段没有已扣减的消耗（排样后要在排样页点「按 FIFO 扣减库存」）</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>日期</th>
                <th>任务</th>
                <th>规格</th>
                <th class="num">估算张</th>
                <th class="num">实际张</th>
                <th class="num">差</th>
                <th>取自批次（FIFO）</th>
                <th class="num">实际成本</th>
                <th>差在哪</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in report.rows" :key="r.c.id">
                <td class="mono">{{ r.c.date }}</td>
                <td>{{ r.c.taskName }}</td>
                <td>{{ specLabel(r.c.wMm, r.c.hMm, r.c.kind) }}</td>
                <td class="num">{{ r.c.estimatedSheets }}</td>
                <td class="num">{{ r.c.actualSheets }}</td>
                <td class="num" :class="r.varianceSheets > 0 ? 'text-warn' : r.varianceSheets < 0 ? 'text-ok' : ''">
                  {{ r.varianceSheets >= 0 ? '+' : '' }}{{ r.varianceSheets }}
                </td>
                <td>
                  <span v-for="({ batch, a }, i) in r.allocations" :key="i" class="alloc-chip">
                    <i class="batch-dot sm" :style="{ background: colorOf(a.batchId) }"></i>
                    {{ batch?.code ?? '批次已删' }} ×{{ a.sheets }}
                    <span class="dim">@{{ yuan4(a.unitCostCents) }}</span>
                  </span>
                </td>
                <td class="num">{{ yuan(r.c.actualCostCents) }}</td>
                <td class="dim" style="max-width: 260px">
                  <template v-if="r.reasons.length">{{ r.reasons.join('；') }}</template>
                  <template v-else>张数一致，且取纸批次单价与估算单价相同</template>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- 消耗流水 -->
        <div class="card">
          <h3>消耗流水（含已还回，留痕可查）</h3>
          <div class="card-sub">一笔消耗只能扣一次；任务删除或重排会自动还回（void），也可在此手工还回</div>
          <div v-if="!ledgerConsumptions.length" class="note">该时段无流水</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>日期</th>
                <th>任务</th>
                <th class="num">张数</th>
                <th class="num">金额</th>
                <th>批次明细</th>
                <th>状态</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in ledgerConsumptions" :key="c.id">
                <td class="mono">{{ c.date }}</td>
                <td>{{ c.taskName }}</td>
                <td class="num">{{ c.actualSheets }}</td>
                <td class="num">{{ yuan(c.actualCostCents) }}</td>
                <td class="dim" style="font-size: 12px">{{ allocText(c) }}</td>
                <td>
                  <span class="badge" :class="c.status === 'posted' ? 'ok' : 'warn'">
                    {{ c.status === 'posted' ? '已扣' : '已还回' }}
                  </span>
                  <div v-if="c.voidReason" class="dim" style="font-size: 11px; max-width: 180px">{{ c.voidReason }}</div>
                </td>
                <td>
                  <button v-if="c.status === 'posted'" class="btn small" @click="voidConsumption(c.id)">
                    还回
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dim {
  color: var(--ink-3);
  font-size: 11.5px;
}
.text-danger {
  color: var(--danger);
}
.text-warn {
  color: var(--warn);
}
.text-ok {
  color: var(--ok);
}
.batch-dot {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 2px;
  margin-right: 4px;
  vertical-align: middle;
}
.batch-dot.sm {
  width: 7px;
  height: 7px;
}
.alloc-chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  background: var(--line-2);
  border-radius: 4px;
  padding: 0 6px;
  margin: 1px 3px 1px 0;
  font-size: 12px;
  white-space: nowrap;
}
.stat {
  background: #fafbfd;
  border: 1px solid var(--line-2);
  border-radius: 6px;
  padding: 8px 10px;
}
.stat span {
  display: block;
  color: var(--ink-3);
  font-size: 11.5px;
}
.stat strong {
  font-family: var(--font-mono);
  font-size: 16px;
}
</style>
