import { memo, useState } from 'react'
import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts'

/**
 * Dashboard charts live in their own module so the charting library (large) is loaded after the first paint
 * instead of blocking it. Hover state is local here, so moving the mouse over the donut re-renders only the donut.
 */
const PALETTE = ['#8257FF', '#27D9FF', '#FF55B8', '#20D6A0', '#FFB04D']

export interface AllocationSlice {
  name: string
  value: number
}

export const AllocationDonut = memo(function AllocationDonut({ data, total }: { data: AllocationSlice[]; total: number }) {
  const [hover, setHover] = useState<number>()
  const active = hover !== undefined ? data[hover] : undefined
  return (
    <>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" innerRadius="66%" outerRadius="94%" paddingAngle={4} cornerRadius={8} stroke="none" isAnimationActive={false} onMouseEnter={(_, i) => setHover(i)} onMouseLeave={() => setHover(undefined)}>
            {data.map((d, i) => (
              <Cell key={d.name} fill={PALETTE[i % PALETTE.length]} opacity={hover === undefined || hover === i ? 1 : 0.35} />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
        <span className="label">{active ? active.name : 'Allocation'}</span>
        <span className="font-display text-2xl font-bold tabular">{active && total > 0 ? `${((active.value / total) * 100).toFixed(1)}%` : `${data.length} asset${data.length === 1 ? '' : 's'}`}</span>
      </div>
    </>
  )
})

export interface FlowBucket {
  label: string
  In: number
  Out: number
}

export const FlowBars = memo(function FlowBars({ data }: { data: FlowBucket[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} barGap={4}>
        <XAxis dataKey="label" tick={{ fill: '#8b93b8', fontSize: 11 }} axisLine={false} tickLine={false} />
        <Tooltip cursor={{ fill: 'rgba(255,255,255,.05)' }} contentStyle={{ background: '#141A2E', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 14, color: '#fff' }} formatter={(v) => `${Number(v).toFixed(2)} USDC`} />
        <Bar dataKey="In" fill="#20D6A0" radius={[8, 8, 0, 0]} isAnimationActive={false} />
        <Bar dataKey="Out" fill="#FF55B8" radius={[8, 8, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  )
})
