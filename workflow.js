export const STEP_LABELS={rendering:"效果图",production:"生产",production_shipping:"完成生产并发货",ready_to_ship:"选择发货方式",shipping_selection:"选择发货方式",tracking:"填写物流单号",air_pickup:"等待提取",delivery:"等待签收",domestic_customs:"国内清关开船",ocean_transit:"海上运输",overseas_customs:"海外清关提柜",warehouse_appointment:"海外仓约车",last_mile:"目的地派送",batch_shipping:"分批物流",completed:"订单完成"};
export function firstStep(order){if(order.inventory_mode==='stock')return {key:'shipping_selection',days:1};if(order.needs_rendering)return {key:'rendering',days:3};return {key:'production',days:10}}
export function nextShipping(order){
 if(!order.shipping_mode)return {key:'shipping_selection',days:1};
 if(order.shipping_mode==='air_freight')return {key:'air_pickup',days:10};
 if(order.shipping_mode==='domestic_express')return {key:'tracking',days:2};
 if(order.shipping_mode==='overseas_warehouse')return {key:'tracking',days:order.overseas_method==='truck'?5:2};
 return {key:'domestic_customs',days:order.sea_region==='europe'?14:10};
}
export function oceanTransitDays(order){
 const standard=order.sea_region==='europe'?40:16;
 const zhongyiNonEurope=String(order.forwarder_name||'').trim()==='众一'&&order.sea_region!=='europe';
 return standard+(zhongyiNonEurope?4:0);
}
export function nextStep(order,current){
 if(current==='order_created')return firstStep(order);
 if(current==='rendering')return {key:'production',days:11};
 if(current==='production')return nextShipping(order);
 if(current==='ready_to_ship'||current==='shipping_selection')return nextShipping(order);
 if(current==='tracking')return {key:'delivery',days:order.shipping_mode==='domestic_express'?10:7};
 if(current==='air_pickup')return {key:'delivery',days:7};
 if(current==='delivery')return {key:'completed',days:null};
 if(current==='domestic_customs')return {key:'ocean_transit',days:oceanTransitDays(order)};
 if(current==='ocean_transit')return order.shipping_mode==='domestic_sea_port'?{key:'completed',days:null}:{key:'overseas_customs',days:7};
 if(current==='overseas_customs')return {key:'warehouse_appointment',days:7};
 if(current==='warehouse_appointment')return {key:'last_mile',days:7};
 if(current==='last_mile')return {key:'completed',days:null};
 return firstStep(order);
}
export function deadline(days,from=new Date()){if(days==null)return null;const d=new Date(from);d.setDate(d.getDate()+days);return d.toISOString()}
export function effectiveStepDeadline(order){
 if(order?.current_step!=='ocean_transit'||String(order?.forwarder_name||'').trim()!=='众一'||!order?.step_started_at)return order?.step_deadline||null;
 return deadline(oceanTransitDays(order),new Date(order.step_started_at));
}
export const RED_OVERDUE_AFTER_DAYS=7;
export function alertLevel(value){if(!value)return 'normal';const today=new Date(),due=new Date(value);today.setHours(0,0,0,0);due.setHours(0,0,0,0);const overdue=Math.round((today-due)/86400000);if(overdue<=0)return 'normal';if(overdue<=RED_OVERDUE_AFTER_DAYS)return 'yellow';return 'red'}


export function flowFor(order){if(order.current_step==='batch_shipping')return ['batch_shipping','completed'];const start=order.inventory_mode==='stock'?['shipping_selection']:order.needs_rendering?['rendering','production','production_shipping']:['production','production_shipping'];if(order.shipping_mode==='air_freight')return [...start,'air_pickup','delivery','completed'];if(order.shipping_mode==='domestic_express')return [...start,'tracking','delivery','completed'];if(order.shipping_mode==='overseas_warehouse')return [...start,'tracking','delivery','completed'];if(order.shipping_mode==='domestic_sea_port')return [...start,'domestic_customs','ocean_transit','completed'];return [...start,'domestic_customs','ocean_transit','overseas_customs','warehouse_appointment','last_mile','completed']}

export function overallDeadline(order){
 if(!order?.order_date||order.current_step==='completed')return null;if(order.current_step==='batch_shipping')return order.step_deadline||null;
 const start=new Date(order.order_date+'T00:00:00');
 if(order.current_step==='rendering')return deadline(3,start);
 const base=order.inventory_mode==='stock'?0:(order.needs_rendering?11:10);
 if(order.current_step==='production')return deadline(base,start);
 if(order.current_step==='ready_to_ship'||order.current_step==='shipping_selection')return deadline(base+1,start);
 if(order.current_step==='air_pickup')return deadline(base+10,start);
 if(order.current_step==='tracking'){const trackingDays=order.shipping_mode==='overseas_warehouse'&&order.overseas_method==='truck'?5:2;return deadline(base+trackingDays,start)}
 if(order.current_step==='delivery'){if(order.shipping_mode==='air_freight')return deadline(base+17,start);const trackingDays=order.shipping_mode==='overseas_warehouse'&&order.overseas_method==='truck'?5:2;const deliveryDays=order.shipping_mode==='domestic_express'?10:7;return deadline(base+trackingDays+deliveryDays,start)}
 const europe=order.sea_region==='europe',customs=europe?14:10,ocean=oceanTransitDays(order);
 const seaTotals={domestic_customs:customs,ocean_transit:customs+ocean,overseas_customs:customs+ocean+7,warehouse_appointment:customs+ocean+14,last_mile:customs+ocean+21};
 return deadline(base+(seaTotals[order.current_step]??0),start);
}
export function orderAlertLevel(order){const rank={normal:0,yellow:1,red:2},stage=alertLevel(effectiveStepDeadline(order)),overall=alertLevel(overallDeadline(order));return rank[stage]>=rank[overall]?stage:overall}
