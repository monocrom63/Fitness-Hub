import React from 'react';
import { useGetDashboardAnalytics, getGetDashboardAnalyticsQueryKey } from '@workspace/api-client-react';
import type { Me } from '@workspace/api-client-react';
import { Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useStudioScope } from './StudioScope';

const periods = [
  { value: 'day', label: 'Heute' },
  { value: 'month', label: 'Monat' },
  { value: 'quarter', label: 'Quartal' },
  { value: 'year', label: 'Jahr' },
] as const;
const genderLabels: Record<string, string> = { female: 'Weiblich', male: 'Männlich', diverse: 'Divers' };
const chartColors = ['hsl(var(--chart-1))', 'hsl(var(--chart-2))', 'hsl(var(--chart-3))'];

export default function DashboardAnalytics({ me }: { me: Me }) {
  const [period, setPeriod] = React.useState<(typeof periods)[number]['value']>('day');
  const { selectedStudioId } = useStudioScope();
  const params = { period, ...(me.role === 'district_manager' && selectedStudioId ? { studioId: selectedStudioId } : {}) };
  const query = useGetDashboardAnalytics(params, {
    query: { queryKey: getGetDashboardAnalyticsQueryKey(params), refetchInterval: 60_000 },
  });
  const data = query.data;
  return <section className="dashboard-analytics" aria-label="Studio-Kennzahlen">
    <div className="analytics-header">
      <div><div className="eyebrow">Auswertung</div><h2>Dein Studio im Überblick</h2></div>
      <div className="analytics-periods" role="tablist" aria-label="Auswertungszeitraum">
        {periods.map(option => <button type="button" key={option.value} role="tab" aria-selected={period === option.value} className={period === option.value ? 'active' : ''} onClick={() => setPeriod(option.value)}>{option.label}</button>)}
      </div>
    </div>
    {query.isError ? <div className="analytics-error" role="alert"><p>Die Auswertung konnte nicht geladen werden.</p><button className="button button-outline" onClick={() => void query.refetch()}>Erneut versuchen</button></div>
      : query.isLoading || !data ? <div className="analytics-loading" role="status">Kennzahlen werden geladen …</div>
      : <>
        <div className="analytics-grid">
          <article className="analytics-card">
            <div className="analytics-card-title"><div><span className="eyebrow">Besuche</span><h3>Zutritte nach Uhrzeit</h3></div><span className="analytics-caption">{data.openingTime}–{data.closingTime} Uhr</span></div>
            <div className="analytics-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.checkInsByHour} margin={{ top: 8, right: 8, bottom: 2, left: -16 }}><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="hour" tickFormatter={(hour) => `${String(hour).padStart(2, '0')}`} tickLine={false} axisLine={false} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} /><Tooltip labelFormatter={(hour) => `${String(hour).padStart(2, '0')}:00 Uhr`} /><Bar dataKey="count" name="Zutritte" radius={[5, 5, 0, 0]}>{data.checkInsByHour.map(item => <Cell key={item.hour} fill={item.hour === data.currentHour ? chartColors[1] : chartColors[0]} />)}</Bar></BarChart></ResponsiveContainer></div>
            <p className="analytics-footnote">Die aktuelle Stunde ist farblich hervorgehoben.</p>
          </article>
          <article className="analytics-card">
            <div className="analytics-card-title"><div><span className="eyebrow">Mitgliedschaften</span><h3>Vertragsabschlüsse</h3></div><div className={`analytics-trend ${data.contractChangePercent !== null && data.contractChangePercent >= 0 ? 'up' : 'down'}`}>{data.contractChangePercent === null ? 'Kein Vorzeitraum' : `${data.contractChangePercent > 0 ? '+' : ''}${data.contractChangePercent}%`}</div></div>
            <strong className="analytics-total">{data.signedContracts}</strong><span className="analytics-total-label">unterschrieben · Vorzeitraum {data.previousContracts}</span>
            <div className="analytics-chart"><ResponsiveContainer width="100%" height="100%"><BarChart data={data.contractBuckets} margin={{ top: 8, right: 8, bottom: 2, left: -16 }}><CartesianGrid vertical={false} strokeDasharray="3 3" /><XAxis dataKey="label" tickLine={false} axisLine={false} /><YAxis allowDecimals={false} tickLine={false} axisLine={false} /><Tooltip /><Bar dataKey="current" name="Zeitraum" fill={chartColors[0]} radius={[5, 5, 0, 0]} /><Bar dataKey="previous" name="Vorzeitraum" fill={chartColors[2]} radius={[5, 5, 0, 0]} /></BarChart></ResponsiveContainer></div>
          </article>
          <article className="analytics-card analytics-card--gender">
            <div className="analytics-card-title"><div><span className="eyebrow">Mitglieder</span><h3>Verteilung nach Geschlecht</h3></div></div>
            {data.genderCounts.reduce((sum, item) => sum + item.count, 0) === 0
              ? <div className="analytics-empty">Noch keine freiwilligen Angaben vorhanden.</div>
              : <div className="gender-chart"><ResponsiveContainer width="100%" height="100%"><PieChart><Pie data={data.genderCounts.map(item => ({ ...item, name: genderLabels[item.gender] }))} dataKey="count" nameKey="name" innerRadius={52} outerRadius={88} paddingAngle={3}>{data.genderCounts.map((item, index) => <Cell key={item.gender} fill={chartColors[index]} />)}</Pie><Tooltip /></PieChart></ResponsiveContainer><ul>{data.genderCounts.map((item, index) => <li key={item.gender}><i style={{ background: chartColors[index] }} /><span>{genderLabels[item.gender]}</span><strong>{item.count}</strong></li>)}</ul></div>}
            <p className="analytics-footnote">Nur freiwillig hinterlegte Angaben; fehlende Angaben werden nicht geschätzt.</p>
          </article>
        </div>
      </>}
  </section>;
}
