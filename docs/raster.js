// Area-overlap resampling and alpha masks follow raster/NoData semantics.
const clamp=v=>Math.max(0,Math.min(255,v));
const squared=(a,b)=>(a[0]-b[0])**2+(a[1]-b[1])**2+(a[2]-b[2])**2;
const linear=Float64Array.from({length:256},(_,v)=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
const srgb=v=>Math.round(clamp(255*(v<=.0031308?12.92*v:1.055*Math.max(0,v)**(1/2.4)-.055)));
const binKey=(r,g,b)=>((r>>4)<<8)|((g>>4)<<4)|(b>>4);
const rare=c=>/^[PR]\d/i.test(c.code);
function nearest(lab,centers){let index=0,best=Infinity;for(let k=0;k<centers.length;k++){const d=squared(lab,centers[k]);if(d<best){best=d;index=k;}}return {index,distance:best};}

// Deterministic, alpha-weighted Lab k-means on a compact color histogram.
export function clusterHistogram(samples,k,toLab){
 if(!samples.length)return {colors:[],labels:new Int16Array()};
 const points=samples.map(s=>({...s,lab:toLab(s.rgb)})),centers=[points.reduce((a,b)=>b.weight>a.weight?b:a).lab.slice()];
 const best=new Float64Array(points.length).fill(Infinity);
 while(centers.length<Math.min(k,points.length)){
  const last=centers[centers.length-1];let winner=-1,score=0;
  for(let i=0;i<points.length;i++){best[i]=Math.min(best[i],squared(points[i].lab,last));const value=best[i]*Math.sqrt(points[i].weight);if(value>score){score=value;winner=i;}}
  if(winner<0||score<.01)break;centers.push(points[winner].lab.slice());
 }
 const labels=new Int16Array(points.length);
 for(let iter=0;iter<12;iter++){
  const sums=centers.map(()=>[0,0,0,0]);let moved=0;
  for(let i=0;i<points.length;i++){const label=nearest(points[i].lab,centers).index;if(labels[i]!==label)moved++;labels[i]=label;const s=sums[label],p=points[i];for(let j=0;j<3;j++)s[j]+=p.lab[j]*p.weight;s[3]+=p.weight;}
  for(let k=0;k<centers.length;k++)if(sums[k][3])centers[k]=sums[k].slice(0,3).map(v=>v/sums[k][3]);
  if(!moved&&iter>0)break;
 }
 const sums=centers.map(()=>[0,0,0,0]);
 for(let i=0;i<points.length;i++){const p=points[i],label=nearest(p.lab,centers).index;labels[i]=label;for(let j=0;j<3;j++)sums[label][j]+=p.rgb[j]*p.weight;sums[label][3]+=p.weight;}
 return {colors:sums.map(s=>s[3]?s.slice(0,3).map(v=>Math.round(v/s[3])):[0,0,0]),labels};
}

function correctedSource(data,o){
 const src=data.data,out=new Uint8ClampedArray(src.length);let low=0,high=255;
 if(o.autoTone){const hist=new Uint32Array(256);let n=0;for(let i=0;i<src.length;i+=4)if(src[i+3]>=128){hist[Math.round(.2126*src[i]+.7152*src[i+1]+.0722*src[i+2])]++;n++;}let count=0;for(let i=0;i<256;i++){count+=hist[i];if(count<n*.01)low=i;if(count<n*.99)high=i;}if(high-low<8||high-low>220){low=0;high=255;}}
 const hist=new Map();
 for(let i=0;i<src.length;i+=4){const a=src[i+3];out[i+3]=a;if(!a)continue;let values=[src[i],src[i+1],src[i+2]],lum=.2126*values[0]+.7152*values[1]+.0722*values[2];
  if(o.autoTone){const change=(clamp((lum-low)*235/(high-low)+10)-lum)*.7;values=values.map(v=>v+change);}
  values=values.map(v=>(v*o.brightness-128)*o.contrast+128);lum=.2126*values[0]+.7152*values[1]+.0722*values[2];values=values.map(v=>Math.round(clamp(lum+(v-lum)*o.saturation)));out.set(values,i);
  const key=binKey(...values),weight=a/255;let bin=hist.get(key);if(!bin){bin={key,sums:[0,0,0],weight:0};hist.set(key,bin);}for(let j=0;j<3;j++)bin.sums[j]+=values[j]*weight;bin.weight+=weight;
 }
 return {pixels:out,samples:[...hist.values()].sort((a,b)=>a.key-b.key).map(s=>({key:s.key,rgb:s.sums.map(v=>v/s.weight),weight:s.weight}))};
}

export function resample(data,o,toLab,progress=()=>{}){
 const {pixels:src,samples}=correctedSource(data,o),sw=data.width,sh=data.height,w=o.width,h=o.height;
 const clusterCount=o.cartoon?(o.clusterCount||Math.max(3,Math.min(16,Math.round(Math.sqrt(samples.length)/2)))):48;
 const clustered=clusterHistogram(samples,clusterCount,toLab),labels=new Int16Array(4096).fill(-1);
 samples.forEach((s,i)=>labels[s.key]=clustered.labels[i]);
 progress(20,o.cartoon?'颜色聚类完成，按面积统计主要色块':'按覆盖面积统计每格代表色');
 const rgb=new Uint8Array(w*h*3),visible=new Uint8Array(w*h),factor=Math.min(w/sw,h/sh),fw=Math.max(1,Math.round(sw*factor)),fh=Math.max(1,Math.round(sh*factor)),left=Math.floor((w-fw)/2),top=Math.floor((h-fh)/2);
 const groups=clustered.colors.length;
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){
  const i=y*w+x;if(x<left||y<top||x>=left+fw||y>=top+fh){rgb.set([255,255,255],i*3);visible[i]=o.empty?0:1;continue;}
  const ax=(x-left)*sw/fw,bx=(x-left+1)*sw/fw,ay=(y-top)*sh/fh,by=(y-top+1)*sh/fh;
  let alpha=0,area=0,sums=[0,0,0];const votes=new Float64Array(groups),colors=Array.from({length:groups},()=>[0,0,0]);
  const add=(xx,yy,weight)=>{if(xx<0||yy<0||xx>=sw||yy>=sh||weight<=0)return;const p=(yy*sw+xx)*4,a=src[p+3]/255*weight;area+=weight;alpha+=a;if(!a)return;const color=[src[p],src[p+1],src[p+2]],label=labels[binKey(...color)];if(label<0)return;const value=o.cartoon?clustered.colors[label]:color;votes[label]+=a;for(let j=0;j<3;j++){const l=linear[value[j]]*a;sums[j]+=l;colors[label][j]+=l;}};
  if(o.sampling==='nearest'){add(Math.min(sw-1,Math.floor((ax+bx)/2)),Math.min(sh-1,Math.floor((ay+by)/2)),1);}
  else for(let yy=Math.floor(ay);yy<Math.ceil(by);yy++)for(let xx=Math.floor(ax);xx<Math.ceil(bx);xx++)add(xx,yy,(Math.min(bx,xx+1)-Math.max(ax,xx))*(Math.min(by,yy+1)-Math.max(ay,yy)));
  const coverage=area?alpha/area:0;visible[i]=!o.empty||(alpha>0&&coverage>=.45)?1:0;
  let value=[255,255,255];if(alpha){let winner=0;for(let k=1;k<groups;k++)if(votes[k]>votes[winner])winner=k;const dominant=o.sampling==='representative'&&votes[winner]/alpha>=.45;
   value=(dominant?colors[winner]:sums).map(v=>srgb(v/(dominant?votes[winner]:alpha)));
   if(!o.empty)value=value.map(v=>srgb(linear[v]*coverage+(1-coverage)));
  }rgb.set(value,i*3);
 }
 if(o.local||o.detail){const original=rgb.slice(),amount=o.local*.6+o.detail*.5;for(let y=1;y<h-1;y++)for(let x=1;x<w-1;x++){const i=y*w+x;if(!visible[i])continue;for(let k=0;k<3;k++){let n=0,sum=0;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const j=(y+dy)*w+x+dx;if(visible[j]){sum+=original[j*3+k];n++;}}rgb[i*3+k]=clamp(Math.round(original[i*3+k]+amount*(original[i*3+k]-sum/n)));}}}
 return {rgb,visible,clusterCount:clustered.colors.length};
}

// Flood only the external NoData component. Enclosed holes never create outlines.
export function exteriorOutline(visible,w,h,thickness=1){
 const pw=w+2,ph=h+2,outside=new Uint8Array(pw*ph),queue=new Int32Array(pw*ph);let head=0,tail=1;queue[0]=0;outside[0]=1;
 const empty=(x,y)=>x===0||y===0||x===pw-1||y===ph-1||!visible[(y-1)*w+x-1];
 while(head<tail){const p=queue[head++],x=p%pw,y=Math.floor(p/pw);for(const [xx,yy] of [[x-1,y],[x+1,y],[x,y-1],[x,y+1]])if(xx>=0&&yy>=0&&xx<pw&&yy<ph){const j=yy*pw+xx;if(!outside[j]&&empty(xx,yy)){outside[j]=1;queue[tail++]=j;}}}
 let line=new Uint8Array(w*h);
 for(let y=0;y<h;y++)for(let x=0;x<w;x++){const i=y*w+x;if(!visible[i])continue;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++)if(outside[(y+1+dy)*pw+x+1+dx])line[i]=1;}
 for(let step=1;step<thickness;step++){const next=line.slice();for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(line[y*w+x])for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){const xx=x+dx,yy=y+dy;if(xx>=0&&yy>=0&&xx<w&&yy<h&&visible[yy*w+xx])next[yy*w+xx]=1;}line=next;}
 return line;
}

function representatives(rgb,mask,toLab){const hist=new Map();for(let i=0;i<mask.length;i++)if(mask[i]){const value=Array.from(rgb.subarray(i*3,i*3+3)),key=binKey(...value);let b=hist.get(key);if(!b){b={rgb:[0,0,0],weight:0};hist.set(key,b);}for(let k=0;k<3;k++)b.rgb[k]+=value[k];b.weight++;}return [...hist.values()].map(p=>({...p,lab:toLab(p.rgb.map(v=>v/p.weight))}));}
function selectPalette(rgb,mask,palette,limit,toLab){
 if(!mask.some(Boolean))return palette.slice(0,1);
 const reps=representatives(rgb,mask,toLab),labs=palette.map(c=>toLab(c.rgb)),weights=reps.reduce((n,p)=>n+p.weight,0),distances=reps.map(p=>Float64Array.from(labs,lab=>squared(p.lab,lab))),best=new Float64Array(reps.length).fill(Infinity),selected=[];
 const auto=limit===0,max=auto?Math.min(48,palette.length):Math.min(limit,palette.length);let score=Infinity;
 for(let k=0;k<max;k++){let winner=-1,next=Infinity;for(let j=0;j<palette.length;j++){if(selected.includes(j))continue;let s=0;for(let i=0;i<reps.length;i++)s+=Math.min(best[i],distances[i][j])*reps[i].weight;if(s<next){next=s;winner=j;}}
  if(winner<0)break;if(auto&&k>=2&&(score/weights<30||(score-next)/Math.max(score,1)<.035))break;
  if(k>0&&score-next<.0001)break;selected.push(winner);score=next;for(let i=0;i<reps.length;i++)best[i]=Math.min(best[i],distances[i][winner]);
 }
 return selected.map(i=>palette[i]);
}

export function convertRaster(data,palette,settings,progress,{rgbToLab,validatePalette}){
 palette=validatePalette(palette);const o={width:50,height:0,limit:0,brightness:1,contrast:1,saturation:1,autoTone:false,local:0,detail:0,dither:false,empty:true,sampling:'representative',cartoon:false,clusterCount:0,rareAccents:true,backgroundRemoved:false,outline:'none',thickness:1,...settings};
 o.width=Number(o.width);o.height=Number(o.height)||Math.max(1,Math.round(o.width*data.height/data.width));if(o.pixel)o.sampling='nearest';
 if(!Number.isInteger(o.width)||!Number.isInteger(o.height)||o.width<1||o.height<1||o.width>256||o.height>256)throw Error('横纵格数需为 1～256 的整数');
 if(!Number.isInteger(o.limit)||o.limit<0||o.limit>256)throw Error('色号数量需为 1～256，或选择自动');
 if(!['representative','average','nearest'].includes(o.sampling)||!Number.isInteger(o.clusterCount)||o.clusterCount<0||o.clusterCount>48)throw Error('取色或聚类参数无效');
 for(const key of ['brightness','contrast','saturation'])if(!Number.isFinite(o[key])||o[key]<.2||o[key]>3)throw Error('色彩参数无效');
 if(!['none','outer'].includes(o.outline)||!Number.isInteger(o.thickness)||o.thickness<1||o.thickness>3)throw Error('只支持主体外轮廓描边，粗细为 1～3 格');
 if(!data.width||!data.height||data.data.length!==data.width*data.height*4)throw Error('照片数据无效');
 let transparent=false,hasInk=false;for(let i=3;i<data.data.length;i+=4){if(data.data[i]<128)transparent=true;else hasInk=true;}
 if(!hasInk)throw Error('画面中没有可用主体，请恢复照片或重新输入文字');
 if(o.outline!=='none'&&(!o.backgroundRemoved||!transparent||!o.empty))throw Error('请先去除背景并保留透明区域，再使用主体外轮廓描边');
 progress(5,'整理有效像素与透明背景');const {rgb,visible,clusterCount}=resample(data,o,rgbToLab,progress),w=o.width,h=o.height;
 if(!visible.some(Boolean))throw Error('主体在当前网格下过小，请增加横纵格数');
 const stroke=o.outline==='outer'?exteriorOutline(visible,w,h,o.thickness):new Uint8Array(w*h),hasStroke=stroke.some(Boolean),mask=visible.map((v,i)=>stroke[i]?0:v);
 const common=palette.filter(c=>!rare(c));if(!common.length)throw Error('当前色卡仅有 P/R 色系，请加入常用色号后重试');
 let black=null;if(hasStroke){black=common.reduce((a,b)=>squared(b.rgb,[0,0,0])<squared(a.rgb,[0,0,0])?b:a);if(Math.max(...black.rgb)>55)throw Error('当前色卡缺少黑色，请加入黑色色号后重试');if(o.limit===1&&mask.some(Boolean))throw Error('主体加黑边至少需要 2 个色号，请增加色数或使用自动');}
 const base=black?common.filter(c=>c.code!==black.code):common,limit=o.limit?Math.max(1,o.limit-(hasStroke?1:0)):0;
 progress(35,'用常用色系匹配代表色');let selected=selectPalette(rgb,mask,base.length?base:[black],limit,rgbToLab);
 if(black&&!selected.some(c=>c.code===black.code))selected.push(black);
 const labs=selected.map(c=>rgbToLab(c.rgb)),grid=new Int32Array(w*h).fill(-1),work=o.dither&&!o.cartoon?Float32Array.from(rgb):rgb,accents=[];
 const rareColors=o.rareAccents?palette.filter(rare):[],rareLabs=rareColors.map(c=>rgbToLab(c.rgb));
 for(let y=0;y<h;y++){for(let x=0;x<w;x++){const i=y*w+x;if(!visible[i])continue;const value=Array.from(work.subarray(i*3,i*3+3)).map(clamp),lab=rgbToLab(value),match=nearest(lab,labs);grid[i]=match.index;
   if(!stroke[i]&&rareLabs.length){const alt=nearest(lab,rareLabs),gain=Math.sqrt(match.distance)-Math.sqrt(alt.distance);if(gain>=8&&alt.distance<100)accents.push({i,color:rareColors[alt.index],gain});}
   if(o.dither&&!o.cartoon&&!stroke[i]){const error=value.map((v,k)=>v-selected[match.index].rgb[k]);for(const [dx,dy,weight] of [[1,0,7/16],[-1,1,3/16],[0,1,5/16],[1,1,1/16]]){const xx=x+dx,yy=y+dy,j=yy*w+xx;if(xx>=0&&xx<w&&yy<h&&visible[j]&&!stroke[j])for(let k=0;k<3;k++)work[j*3+k]+=error[k]*weight;}}
  }if(y%16===0)progress(45+Math.round(40*y/h),'映射常用色号');}
 // An accent family is admitted only if its entire candidate region is small.
 const counts=new Map();for(const a of accents)counts.set(a.color.code,(counts.get(a.color.code)||0)+1);
 const maxAccents=Math.floor(visible.reduce((n,v)=>n+v,0)*.03);let added=0;
 for(const a of accents.sort((a,b)=>b.gain-a.gain)){if(added>=maxAccents)break;if(counts.get(a.color.code)>maxAccents)continue;let index=selected.findIndex(c=>c.code===a.color.code);if(index<0){if(o.limit&&selected.length>=o.limit)continue;index=selected.length;selected.push(a.color);}grid[a.i]=index;added++;}
 // Apply the binary external ring only after all resampling and color mapping.
 if(black){const index=selected.findIndex(c=>c.code===black.code);for(let i=0;i<grid.length;i++)if(stroke[i])grid[i]=index;}
 const used=new Set(grid);used.delete(-1);const remap=new Map(),compact=[];selected.forEach((c,i)=>{if(used.has(i)){remap.set(i,compact.length);compact.push(c);}});for(let i=0;i<grid.length;i++)if(grid[i]>=0)grid[i]=remap.get(grid[i]);
 progress(100,'图纸已更新');return {width:w,height:h,palette:compact,grid,metadata:{...o,metric:'CIELAB DeltaE76',resampling:o.sampling,cluster_count:o.cartoon?clusterCount:0,actual_colors:compact.length,rare_accent_cells:added,outline_cells:Array.from(stroke.entries()).filter(([,v])=>v).map(([i])=>i),outline_code:black?.code||null,color_status:'sRGB / linear-light area weights',hand_edited:false}};
}
