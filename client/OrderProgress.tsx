import type { Order } from '../shared/types.js';
import { orderProgress, trackingFreshness } from './order-progress.js';

const formatTime = (date: string) => new Date(date).toLocaleString('zh-CN', { hour12: false });
export default function OrderProgress({ order, credited, now, online, readError, localHash }: {
  order: Order; credited: boolean; now: number; online: boolean; readError?: string; localHash?: string;
}) {
  const facts = orderProgress(order, credited);
  const check = trackingFreshness(order, now);
  const attention = order.status === 'attention';
  const warning = !online ? '当前离线，以下保留上次取得的记录。联网后继续查询，请勿重复付款。'
    : readError ? '暂时无法读取最新订单，以下保留上次取得的记录。请勿重复付款。'
    : credited ? undefined
    : check.state === 'unavailable' ? '最近一次状态查询未完成，资金的最新状态尚不确定。系统会继续查询，请勿重复付款。'
    : check.state === 'stale' ? '超过 1 分钟未取得新的状态查询结果，以下保留上次确认的信息。请勿重复付款。'
    : check.state === 'unknown' ? '尚无可用的状态查询时间，不能据此判断当前资金进度。' : undefined;
  const message = order.status === 'completed' && !credited ? '到账证据或实际入账金额尚不完整，继续核验中。'
    : localHash && !order.sourceTxHash ? '已保留交易编号，请继续核验。签名窗口到期不代表这笔付款失败。'
    : check.state === 'unavailable' ? undefined : order.statusMessage;
  const steps = [
    { title: '确认源链付款', done: facts.sourceConfirmed, active: !facts.sourceConfirmed,
      text: facts.sourceConfirmed ? '来源付款已最终确认。' : order.sourceTxHash ? '已保存交易编号，等待源链交易确认，尚不代表到账；以最终确认为准。' : '请先核对钱包中的签名与付款结果，交易编号不代表已确认。' },
    { title: '路由执行反馈', done: credited, active: facts.sourceConfirmed && !credited,
      text: credited ? '路由结果已与本单入账证据匹配。' : facts.routeReported ? attention ? '路由曾报告完成，目前仍需进一步核查。' : '路由报告完成，尚不代表 HL 账户已入账。'
        : attention ? '路由结果需要进一步核查，以原订单记录为准。' : facts.sourceConfirmed ? '来源付款已确认，等待路由执行结果。' : '等待来源付款确认。' },
    { title: '核验 HL 入账', done: credited, active: facts.routeReported && !credited,
      text: credited ? '已按本单交易及金额核实默认 Perps USDC 入账。' : '尚未核实本单进入默认 Perps 账户，路由完成或账户余额变化不能代替入账证据。' },
  ];
  return <section className="card progress-card" aria-label="订单核验进度">
    <div className="confirmed-progress"><span>最后已确认的资金步骤</span><strong>{facts.lastConfirmed}</strong>{facts.confirmedAt && <small>确认记录时间 <time dateTime={facts.confirmedAt}>{formatTime(facts.confirmedAt)}</time></small>}</div>
    <div className="vertical-steps">{steps.map((step, index) => <div className={`progress-step ${step.done ? 'done' : step.active ? 'active' : ''}`} key={step.title}><div className="step-track"><span>{step.done ? '✓' : index + 1}</span></div><div><h2>{step.title}</h2><p>{step.text}</p></div></div>)}</div>
    <div className="query-freshness" aria-label="状态查询时间">
      <span>最近成功查询 <strong>{check.succeededAt ? <time dateTime={check.succeededAt}>{formatTime(check.succeededAt)}</time> : '暂无记录'}</strong></span>
      {check.attemptedAt && check.state === 'unavailable' && <small>最近查询尝试 <time dateTime={check.attemptedAt}>{formatTime(check.attemptedAt)}</time></small>}
      <small>查询成功只表示取得查询结果，不代表资金已到账。</small>
    </div>
    {warning && <p className="progress-query-warning" role="status">{warning}</p>}
    {(message || order.quote.warnings.length > 0) && <div className="order-message">{message && <p>{message}</p>}{order.quote.warnings.map((text, index) => <p className="quote-warning" key={index}>{text}</p>)}</div>}
  </section>;
}
