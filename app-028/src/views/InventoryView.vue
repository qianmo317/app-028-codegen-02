<script setup lang="ts">
import { computed, reactive, ref } from 'vue'
import { useRouter } from 'vue-router'
import {
  addBatch,
  allPapers,
  batches,
  consumptions,
  removeBatch,
  tasks,
} from '../store'
import {
  batchBalances,
  dayEnd,
  dayStart,
  formatDate,
  fromDateInput,
  periodReport,
  reconcile,
  toDateInput,
  unitPriceCents,
} from '../logic/inventory'
import { batchBalanceRows, periodCostRows, reconcileRows } from '../logic/inventoryCsv'
import { csvBlob } from '../logic/csv'
import { downloadBlob } from '../logic/image'
import type { BatchUnit, PaperBatch, PaperKind } from '../logic/types'

const router = useRouter()
const msg = ref('')
const msgKind = ref<'ok' | 'danger' | 'warn'>('ok')
function say(text: string, kind: 'ok' | 'danger' | 'warn' = 'ok') {
  msg.value = text
  msgKind.value = kind
}

/* ---------------- 入库登记 ---------------- */

const today = toDateInput(Date.now())
const form = reactive({
  ref: '',
  paperId: 'p5x7' as string,
  customName: '自定义相纸',
  customW: 152,
  customH: 210,
  customKind: 'sheet' as PaperKind,
  unit: 'sheet' as BatchUnit,
  qtyIn: 1,
  unitsPer: 100,
  pricePurchaseYuan: 100,
  inAt: today,
  expiresAt: '',
  note: '',
})

const selectedPaper = computed(() => allPapers.value.find((p) => p.id === form.paperId))

function autoRef(): string {
  const n = batches.value.length + 1
  return `${toDateInput(Date.now()).slice(2).replace(/-/g, '')}-${String.fromCharCode(65 + (n % 26))}`
}

function submitBatch() {
  if (form.qtyIn <= 0) return say('包数/卷数必须大于 0', 'danger')
  if (form.unitsPer <= 0) return say('每包张数 / 每卷可切张数必须大于 0', 'danger')
  const isCustom = form.paperId === 'custom'
  const name = isCustom ? form.customName.trim() || '自定义相纸' : selectedPaper.value?.name ?? '相纸'
  const w = isCustom ? form.customW : selectedPaper.value?.wMm ?? 0
  const h = isCustom ? form.customH : selectedPaper.value?.hMm ?? 0
  const kind: PaperKind = isCustom ? form.customKind : selectedPaper.value?.kind ?? 'sheet'
  if (w <= 0 || h <= 0) return say('相纸尺寸不合法', 'danger')
  const refText = form.ref.trim() || autoRef()
  if (batches.value.some((b) => b.ref === refText)) return say(`批次标签「${refText}」已存在，请换一个`, 'danger')
  const b = addBatch({
    ref: refText,
    paperId: form.paperId,
    paperName: name,
    wMm: w,
    hMm: h,
    kind,
    unit: form.unit,
    qtyIn: form.qtyIn,
    unitsPer: form.unitsPer,
    inAt: fromDateInput(form.inAt),
    expiresAt: form.expiresAt ? fromDateInput(form.expiresAt) + 1000 * 60 * 60 * 23 + 3599000 : 0,
    pricePurchaseCents: Math.round(form.pricePurchaseYuan * 100),
    note: form.note.trim() || undefined,
  })
  say(`已登记批次「${b.ref}」：${b.qtyIn}${b.unit === 'sheet' ? ' 包' : ' 卷'} × ${b.unitsPer}，共 ${b.qtyIn * b.unitsPer} 张`)
  form.ref = ''
  form.note = ''
}

function deleteBatch(b: PaperBatch) {
  const err = removeBatch(b.id)
  if (err) say(err, 'danger')
  else say(`已删除批次「${b.ref}」（无任何扣减记录）`)
}

/* ---------------- 余额（可按时间点查看） ---------------- */

const asOf = ref(toDateInput(Date.now()))
const balancesAt = computed(() => dayEnd(fromDateInput(asOf.value)))
const balances = computed(() => batchBalances(batches.value, consumptions.value, balancesAt.value))
const sortedBalances = computed(() =>
  [...balances.value].sort((a, b) => {
    if (a.shouldUseFirst !== b.shouldUseFirst) return a.shouldUseFirst ? -1 : 1
    return a.batch.inAt - b.batch.inAt
  }),
)
const expirySoon = computed(() => balances.value.filter((b) => b.shouldUseFirst))
const expired = computed(() => balances.value.filter((b) => b.expiryLevel === 0 && b.remaining > 0))

function expiryText(x: (typeof balances.value)[number]): string {
  if (x.expiryLevel === 3 || x.daysToExpiry === null) return ''
  if (x.expiryLevel === 0) return `已过期 ${Math.abs(x.daysToExpiry)} 天`
  return `${x.daysToExpiry} 天到期`
}

/* ---------------- 时间段实际用量 + 成本 ---------------- */

function firstOfMonth(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
const from = ref(firstOfMonth())
const to = ref(toDateInput(Date.now()))
const range = computed(() => ({ from: dayStart(fromDateInput(from.value)), to: dayEnd(fromDateInput(to.value)) }))
const report = computed(() => periodReport(batches.value, consumptions.value, range.value))

const taskRows = computed(() =>
  reconcile(
    tasks.value.map((t) => ({
      id: t.id,
      name: t.name,
      paperName:
        t.paperId === 'custom' && t.customPaper
          ? t.customPaper.name
          : allPapers.value.find((p) => p.id === t.paperId)?.name ?? '未知相纸',
      sheets: t.result?.stats.sheets ?? 0,
      createdAt: t.createdAt,
    })),
    consumptions.value,
  ),
)
const mismatchRows = computed(() => taskRows.value.filter((r) => !(r.reasons.length === 1 && r.reasons[0] === '一致')))

function exportBalances() {
  downloadBlob(
    csvBlob(batchBalanceRows(balances.value, asOf.value)),
    `批次余额-${asOf.value}.csv`,
  )
}
function exportPeriod() {
  downloadBlob(csvBlob(periodCostRows(report.value)), `台账成本清单-${from.value}_${to.value}.csv`)
}
function exportRecon() {
  downloadBlob(
    csvBlob(reconcileRows(taskRows.value, '全部任务')),
    `估实对账.csv`,
  )
}

function openTask(id: string) {
  router.push(`/layout/${id}`)
}

const yuan4 = (c: number) => `¥${(c / 100).toFixed(4)}`
const draftUnitPrice = computed(() => (form.unitsPer > 0 ? (form.pricePurchaseYuan / form.unitsPer) * 100 : 0))
</script>

<template>
  <div class="stack">
    <div class="row">
      <h1 style="margin: 0">库存台账</h1>
      <span class="badge brand">按批次 · 先进先出扣减</span>
      <span class="badge">{{ batches.length }} 批</span>
      <div class="spacer"></div>
    </div>

    <div v-if="msg" class="note" :class="msgKind">{{ msg }}</div>
    <div v-if="expired.length" class="note danger">
      ⚠ {{ expired.length }} 批已过期仍有库存：{{ expired.map((b) => b.batch.ref).join('、') }}，请停止领用
    </div>
    <div v-else-if="expirySoon.length" class="note warn">
      ⏰ 快到期该先用：{{ expirySoon.map((b) => `${b.batch.ref}（剩 ${b.remaining} 张，${expiryText(b)}）`).join('；') }}
      <div class="card-sub" style="margin-top:2px">扣账仍按 FIFO 走最早入库的批次；如要先用快到期的纸，领用后在排样页「重新记账」前先人工调整。</div>
    </div>

    <div class="grid sidebar">
      <!-- 左列：入库 + 余额 -->
      <div class="stack">
        <div class="card">
          <h3>① 入库登记</h3>
          <div class="card-sub">同规格、同日期、同单价的包/卷登记为一批；一批一个价，成本不再按固定单价摊</div>
          <div class="stack">
            <label class="field">
              批次标签（贴包装上对号，可留空自动生成）
              <input v-model="form.ref" type="text" :placeholder="autoRef()" />
            </label>
            <label class="field">
              相纸规格
              <select v-model="form.paperId">
                <option v-for="p in allPapers" :key="p.id" :value="p.id">
                  {{ p.name }} · {{ p.wMm }}×{{ p.hMm }}mm
                </option>
                <option value="custom">自定义规格…</option>
              </select>
            </label>
            <div v-if="form.paperId === 'custom'" class="grid cols-2">
              <label class="field">名称<input v-model="form.customName" type="text" /></label>
              <label class="field">
                纸种
                <select v-model="form.customKind">
                  <option value="sheet">平张</option>
                  <option value="roll">卷筒</option>
                </select>
              </label>
              <label class="field">宽 mm<input v-model.number="form.customW" type="number" min="1" step="0.1" /></label>
              <label class="field">高/切长 mm<input v-model.number="form.customH" type="number" min="1" step="0.1" /></label>
            </div>
            <div class="grid cols-2">
              <label class="field">
                计量单位
                <select v-model="form.unit">
                  <option value="sheet">包（每包若干张）</option>
                  <option value="roll">卷（每卷切若干张）</option>
                </select>
              </label>
              <label class="field">
                包数 / 卷数
                <input v-model.number="form.qtyIn" type="number" min="1" step="1" />
              </label>
              <label class="field">
                每包张数 / 每卷可切张数
                <input v-model.number="form.unitsPer" type="number" min="1" step="1" />
              </label>
              <label class="field">
                采购单价（元 / 每包或每卷）
                <input v-model.number="form.pricePurchaseYuan" type="number" min="0" step="0.01" />
              </label>
              <label class="field">
                入库日期
                <input v-model="form.inAt" type="date" />
              </label>
              <label class="field">
                有效期（可空）
                <input v-model="form.expiresAt" type="date" />
              </label>
            </div>
            <label class="field">
              备注
              <input v-model="form.note" type="text" placeholder="供应商 / 存放位置等" />
            </label>
            <div class="row">
              <button class="btn primary" @click="submitBatch">登记入库</button>
              <span class="badge">折合 {{ yuan4(draftUnitPrice) }}/张</span>
              <span class="badge">共 {{ form.qtyIn * form.unitsPer }} 张</span>
            </div>
          </div>
        </div>

        <div class="card">
          <h3>
            ② 批次余额
            <span class="row tight">
              <label class="field" style="margin:0">
                截至
                <input v-model="asOf" type="date" style="width: 140px" />
              </label>
              <button class="btn small" @click="exportBalances">导出余额表</button>
            </span>
          </h3>
          <div class="card-sub">按时间点回放每批还剩多少（已退还的扣减会把库存加回来）</div>
          <div v-if="!balances.length" class="note">还没有登记任何批次，先在上方入库</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>批次</th>
                <th>规格</th>
                <th class="num">剩余</th>
                <th class="num">已用</th>
                <th class="num">单位价</th>
                <th class="num">有效期</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="x in sortedBalances" :key="x.batch.id" :class="{ danger: x.expiryLevel === 0 && x.remaining > 0 }">
                <td>
                  <strong>{{ x.batch.ref }}</strong>
                  <span v-if="x.shouldUseFirst" class="badge warn" style="margin-left:4px">先用</span>
                  <div class="card-sub">{{ formatDate(x.batch.inAt) }} 入库 · {{ x.batch.qtyIn }}{{ x.batch.unit === 'sheet' ? '包' : '卷' }}×{{ x.batch.unitsPer }}</div>
                </td>
                <td>{{ x.batch.paperName }}<div class="card-sub">{{ x.batch.wMm }}×{{ x.batch.hMm }}</div></td>
                <td class="num"><strong>{{ x.remaining }}</strong></td>
                <td class="num">{{ x.used }}</td>
                <td class="num">{{ yuan4(unitPriceCents(x.batch)) }}</td>
                <td class="num">
                  <span v-if="x.daysToExpiry === null">不限</span>
                  <span :class="x.expiryLevel <= 1 ? 'badge danger' : x.expiryLevel === 2 ? 'badge warn' : ''">
                    {{ formatDate(x.batch.expiresAt) }}<template v-if="x.remaining > 0">（{{ expiryText(x) }}）</template>
                  </span>
                </td>
                <td><button class="btn small danger" @click="deleteBatch(x.batch)">删</button></td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <!-- 右列：时间段用量 / 对账 -->
      <div class="stack">
        <div class="card">
          <h3>
            ③ 时间段实际用量与成本
            <button class="btn small" style="margin-left: 8px" @click="exportPeriod">导出成本清单（带批次）</button>
          </h3>
          <div class="row tight">
            <label class="field" style="margin:0">起 <input v-model="from" type="date" style="width: 140px" /></label>
            <label class="field" style="margin:0">止 <input v-model="to" type="date" style="width: 140px" /></label>
          </div>
          <div class="kv" style="margin-top: 8px">
            <dt>实际用纸</dt>
            <dd><strong>{{ report.actualUnits }}</strong> 张</dd>
            <dt>排样估的</dt>
            <dd>{{ report.estimatedUnits }} 张</dd>
            <dt>估 − 实</dt>
            <dd>
              <span :class="report.diffUnits > 0 ? 'badge danger' : 'badge ok'">{{ report.diffUnits }} 张</span>
              <span v-if="report.diffUnits > 0" class="card-sub">有纸没扣到（一般是库存不足，见下方对账）</span>
            </dd>
            <dt>实际材料成本</dt>
            <dd><strong>{{ yuan4(report.actualCents) }}</strong>（按扣到的各批实际单价汇总）</dd>
          </div>
          <table v-if="report.batchLines.length" class="data" style="margin-top: 8px">
            <thead>
              <tr><th>批次</th><th>规格</th><th class="num">用量</th><th class="num">单位价</th><th class="num">金额</th></tr>
            </thead>
            <tbody>
              <tr v-for="b in report.batchLines" :key="b.batchId">
                <td>{{ b.ref }}</td>
                <td>{{ b.paperName }}</td>
                <td class="num">{{ b.units }}</td>
                <td class="num">{{ yuan4(b.unitPriceCents) }}</td>
                <td class="num">{{ yuan4(b.cents) }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="note" style="margin-top: 8px">这段时间没有已扣账的消耗</div>
        </div>

        <div class="card">
          <h3>
            ④ 估的张数 vs 实际扣减
            <button class="btn small" style="margin-left: 8px" @click="exportRecon">导出对账表</button>
          </h3>
          <div class="card-sub">逐任务指出差在哪：没入库、库存不足、重排后没重新记账、已退还</div>
          <div v-if="!mismatchRows.length" class="note ok">区间内任务账实一致 ✓</div>
          <table v-else class="data">
            <thead>
              <tr>
                <th>任务</th><th>相纸</th><th class="num">估</th><th class="num">实</th><th class="num">差</th><th>差在哪里</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in mismatchRows" :key="r.taskId">
                <td><a href="javascript:void(0)" @click="openTask(r.taskId)">{{ r.taskName }}</a></td>
                <td>{{ r.paperName }}</td>
                <td class="num">{{ r.estimated }}</td>
                <td class="num">{{ r.deducted }}</td>
                <td class="num"><span :class="r.diff === 0 ? '' : 'badge danger'">{{ r.diff }}</span></td>
                <td class="card-sub">{{ r.reasons.join('；') }}</td>
              </tr>
            </tbody>
          </table>
        </div>

        <div class="card">
          <h3>⑤ 这段时间的消耗明细</h3>
          <table class="data">
            <thead>
              <tr><th>时间</th><th>任务</th><th>扣到的批次（张）</th><th class="num">成本</th><th>状态</th></tr>
            </thead>
            <tbody>
              <template v-for="c in consumptions.filter((x) => x.at >= range.from && x.at <= range.to)" :key="c.id">
                <tr>
                  <td class="card-sub">{{ new Date(c.at).toLocaleString() }}</td>
                  <td><a href="javascript:void(0)" @click="openTask(c.taskId)">{{ c.taskName }}</a></td>
                  <td>
                    <template v-if="c.status === 'active'">
                      <span v-for="a in c.allocs" :key="a.batchId" class="badge" style="margin-right:4px">
                        {{ batches.find((b) => b.id === a.batchId)?.ref ?? '?' }} ×{{ a.units }}
                      </span>
                      <span v-if="!c.allocs.length" class="badge danger">未扣到</span>
                    </template>
                    <span v-else class="badge warn">已退还（{{ c.reason }}）</span>
                  </td>
                  <td class="num">{{ c.status === 'active' ? yuan4(c.totalCents) : '—' }}</td>
                  <td>
                    <span v-if="c.status === 'reverted'" class="badge warn">还库 {{ c.revertedAt ? formatDate(c.revertedAt) : '' }}</span>
                    <span v-else-if="c.unitsEstimated > (c.allocs.reduce((s, a) => s + a.units, 0))" class="badge danger">不足</span>
                    <span v-else class="badge ok">正常</span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>
