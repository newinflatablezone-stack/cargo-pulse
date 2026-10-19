import {makeForwarderDateRange,singaporeToday} from './forwarder-analysis-dates.mjs';
import './forwarder-analysis-filter.css';

let selection = {period:'3',start:'',end:''};
export function activeForwarderRange() {
  return makeForwarderDateRange(selection.period,selection.start,selection.end);
}

export function mountForwarderDateFilter(page,onChange) {
  const toolbar = document.createElement('section');
  toolbar.className='analysis-date-filter';
  toolbar.setAttribute('aria-label','货代分析时间筛选');
  toolbar.innerHTML='<div class="analysis-date-heading"><strong>统计时间</strong><div class="analysis-date-presets" role="group" aria-label="统计周期"><button type="button" data-period="1">近一个月</button><button type="button" data-period="3">近三个月</button><button type="button" data-period="6">近半年</button><button type="button" data-period="12">近一年</button><button type="button" data-period="custom">自定义</button></div></div><form class="analysis-date-custom" hidden><label>开始日期<input name="start" type="date" required></label><span>至</span><label>结束日期<input name="end" type="date" required></label><button type="submit">应用筛选</button></form><p class="analysis-date-error" role="alert"></p><p class="analysis-date-range" aria-live="polite"></p>';
  page.querySelector('.forwarder-analysis-head').after(toolbar);
  const form=toolbar.querySelector('form'),error=toolbar.querySelector('.analysis-date-error'),description=toolbar.querySelector('.analysis-date-range');
  let editing=selection.period;
  const paint=()=>{
    const range=activeForwarderRange();
    toolbar.querySelectorAll('[data-period]').forEach(button=>{const selected=button.dataset.period===editing;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
    form.hidden=editing!=='custom';
    description.textContent=`统计范围：${range.start.replaceAll('-','/')} 至 ${range.end.replaceAll('-','/')} · 按下单日期，包含起止当天`;
  };
  const initial=activeForwarderRange();
  form.elements.start.value=selection.start||initial.start;
  form.elements.end.value=selection.end||initial.end;
  form.elements.start.max=singaporeToday();form.elements.end.max=singaporeToday();
  const apply=range=>{selection=range;editing=range.period;error.textContent='';paint();onChange(range);};
  toolbar.querySelectorAll('[data-period]').forEach(button=>button.onclick=()=>{
    editing=button.dataset.period;error.textContent='';
    if(editing==='custom'){if(selection.period!=='custom'){const range=activeForwarderRange();form.elements.start.value=range.start;form.elements.end.value=range.end;}paint();form.elements.start.focus();return;}
    apply(makeForwarderDateRange(editing));
  });
  form.onsubmit=event=>{
    event.preventDefault();
    try{apply(makeForwarderDateRange('custom',form.elements.start.value,form.elements.end.value));}
    catch(caught){error.textContent=caught.message;}
  };
  paint();
}
