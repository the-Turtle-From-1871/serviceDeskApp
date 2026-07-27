"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { CHROME } from "./palette";

/* Shared chart chrome. Grid and axes are deliberately recessive — the data is
   the ink, the frame is the paper. */

const AXIS = {
  stroke: CHROME.axis,
  tick: { fill: CHROME.muted, fontSize: 11 },
  tickLine: false,
} as const;

const TOOLTIP_STYLE = {
  contentStyle: {
    background: CHROME.surface,
    border: `1px solid ${CHROME.axis}`,
    borderRadius: 5,
    fontSize: 12,
    color: CHROME.ink,
    boxShadow: "0 6px 18px rgba(25, 28, 24, 0.12)",
  },
  labelStyle: { color: CHROME.muted, marginBottom: 2 },
  // Text wears text tokens, never the series colour.
  itemStyle: { color: CHROME.ink },
} as const;

/** 2px of surface between stacked segments, per the mark spec — the fills
 *  must not touch, or two adjacent series read as one shape. */
const SEGMENT_GAP = { stroke: CHROME.surface, strokeWidth: 2 } as const;

const CHART_HEIGHT = 240;

/* ------------------------------------------------------------ */

export function DonutChart({
  data,
}: {
  data: Array<{ label: string; value: number; color: string }>;
}) {
  const total = data.reduce((sum, d) => sum + d.value, 0);
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <PieChart>
        <Pie
          data={data}
          dataKey="value"
          nameKey="label"
          innerRadius="58%"
          outerRadius="82%"
          paddingAngle={2}
          startAngle={90}
          endAngle={-270}
          isAnimationActive={false}
        >
          {data.map((d) => (
            <Cell key={d.label} fill={d.color} stroke={CHROME.surface} strokeWidth={2} />
          ))}
        </Pie>
        <Tooltip
          {...TOOLTIP_STYLE}
          // Recharts 3 types the formatter's value as `ValueType | undefined`,
          // so it is coerced here rather than asserted.
          formatter={(value, name) => {
            const n = Number(value ?? 0);
            return [`${n} (${total ? Math.round((n / total) * 100) : 0}%)`, String(name)];
          }}
        />
      </PieChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------ */

export function StackedAreaChart({
  data,
  series,
  xKey,
  formatX,
}: {
  data: Array<Record<string, unknown>>;
  series: Array<{ key: string; label: string; color: string }>;
  xKey: string;
  formatX: (v: string) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={CHROME.grid} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey={xKey} {...AXIS} tickFormatter={formatX} minTickGap={24} />
        <YAxis {...AXIS} allowDecimals={false} width={44} />
        <Tooltip
          {...TOOLTIP_STYLE}
          labelFormatter={(v) => formatX(String(v))}
          formatter={(value, key) => [
            Number(value ?? 0),
            series.find((s) => s.key === String(key))?.label ?? String(key),
          ]}
        />
        {series.map((s) => (
          <Area
            key={s.key}
            type="stepAfter"
            dataKey={s.key}
            name={s.label}
            stackId="fleet"
            fill={s.color}
            fillOpacity={0.85}
            {...SEGMENT_GAP}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}

/* ------------------------------------------------------------ */

export function StackedBarChart({
  data,
  series,
  xKey,
  formatX,
}: {
  data: Array<Record<string, unknown>>;
  series: Array<{ key: string; label: string; color: string }>;
  xKey: string;
  formatX: (v: string) => string;
}) {
  return (
    <ResponsiveContainer width="100%" height={CHART_HEIGHT}>
      <BarChart data={data} margin={{ top: 4, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke={CHROME.grid} strokeDasharray="2 4" vertical={false} />
        <XAxis dataKey={xKey} {...AXIS} tickFormatter={formatX} />
        <YAxis {...AXIS} allowDecimals={false} width={44} />
        <Tooltip
          {...TOOLTIP_STYLE}
          cursor={{ fill: CHROME.grid, fillOpacity: 0.4 }}
          labelFormatter={(v) => formatX(String(v))}
        />
        {series.map((s, i) => (
          <Bar
            key={s.key}
            dataKey={s.key}
            name={s.label}
            stackId="cat"
            fill={s.color}
            {...SEGMENT_GAP}
            // 4px rounded data-end on the topmost segment only; inner segments
            // stay square so the stack reads as one column.
            radius={i === series.length - 1 ? [4, 4, 0, 0] : undefined}
            isAnimationActive={false}
          />
        ))}
      </BarChart>
    </ResponsiveContainer>
  );
}
