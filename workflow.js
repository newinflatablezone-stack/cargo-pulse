export const STEP_LABELS={rendering:"效果图",production:"生产",shipping_selection:"选择发货方式",tracking:"填写物流单号",delivery:"等待送达",domestic_customs:"国内清关开船",ocean_transit:"海上运输",overseas_customs:"海外清关提柜",warehouse_appointment:"海外仓约车",last_mile:"目的地派送",completed:"订单完成"};
export function firstStep(order){if(order.inventory_mode==='stock')return nextShipping(order);if(order.needs_rendering)return {key:'rendering',days:3};return {key:'production',days:10}}
export function nextShipping(order){
 if(!order.shipping_mode)return {key:'shipping_selection',days:null};
 if(order.shipping_mode==='domestic_express')return {key:'tracking',days:2};
 if(order.shipping_mode==='overseas_warehouse')return {key:'tracking',days:order.overseas_method==='truck'?5:2};
 return {key:'domestic_customs',days:order.sea_region==='europe'?14:10};
}
export function nextStep(order,current){
 if(current==='rendering')return {key:'production',days:11};
 if(current==='production'||current==='shipping_selection')return nextShipping(order);
 if(current==='tracking')return {key:'delivery',days:order.shipping_mode==='domestic_express'?10:7};
 if(current==='delivery')return {key:'completed',days:null};
 if(current==='domestic_customs')return {key:'ocean_transit',days:order.sea_region==='europe'?40:16};
 if(current==='ocean_transit')return {key:'overseas_customs',days:7};
 if(current==='overseas_customs')return {key:'warehouse_appointment',days:7};
 if(current==='warehouse_appointment')return {key:'last_mile',days:7};
 if(current==='last_mile')return {key:'completed',days:null};
 return {key:'completed',days:null};
}
export function deadline(days,from=new Date()){if(days==null)return null;const d=new Date(from);d.setDate(d.getDate()+days);return d.toISOString()}
export function alertLevel(value){if(!value)return 'normal';const overdue=Math.floor((Date.now()-new Date(value).getTime())/86400000);if(overdue<0)return 'normal';if(overdue<1)return 'yellow';if(overdue<3)return 'orange';return 'red'}

