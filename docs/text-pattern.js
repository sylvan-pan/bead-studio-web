const canvas=(w,h)=>{const c=document.createElement('canvas');c.width=w;c.height=h;return c;};
const graphemes=s=>typeof Intl.Segmenter==='function'?[...new Intl.Segmenter(undefined,{granularity:'grapheme'}).segment(s)].map(v=>v.segment):Array.from(s);
function topology(c){const {width:w,height:h}=c,data=c.getContext('2d').getImageData(0,0,w,h).data,mask=new Uint8Array(w*h);let ink=0,transitions=0;
 for(let i=0;i<mask.length;i++){mask[i]=data[i*4+3]>=128?1:0;ink+=mask[i];}
 for(let y=0;y<h;y++){let n=0;for(let x=1;x<w;x++)if(mask[y*w+x]!==mask[y*w+x-1])n++;transitions=Math.max(transitions,n);}
 for(let x=0;x<w;x++){let n=0;for(let y=1;y<h;y++)if(mask[y*w+x]!==mask[(y-1)*w+x])n++;transitions=Math.max(transitions,n);}
 const visited=new Uint8Array(w*h),queue=new Int32Array(w*h);let holes=0,components=0;
 for(let i=0;i<mask.length;i++)if(!visited[i]){const color=mask[i];let head=0,tail=1,touches=false;queue[0]=i;visited[i]=1;while(head<tail){const p=queue[head++],x=p%w,y=Math.floor(p/w);if(x===0||y===0||x===w-1||y===h-1)touches=true;for(let dy=-1;dy<=1;dy++)for(let dx=-1;dx<=1;dx++){if(!color&&Math.abs(dx)+Math.abs(dy)!==1)continue;const xx=x+dx,yy=y+dy,j=yy*w+xx;if(xx>=0&&yy>=0&&xx<w&&yy<h&&!visited[j]&&mask[j]===color){visited[j]=1;queue[tail++]=j;}}}if(color&&tail>=2)components++;else if(!color&&!touches&&tail>=2)holes++;}
 return {holes,components,transitions,ink};
}
function glyphSize(char,family){const c=canvas(180,180),ctx=c.getContext('2d');ctx.font=`600 96px ${family}`;ctx.textBaseline='top';ctx.fillText(char,12,12);const original=topology(c);if(!original.ink)return {size:14,complexity:0};
 const minimum=Math.max(14,Math.min(56,Math.ceil(original.transitions*2.2))),sizes=[14,18,22,26,30,36,42,48,56,64];let chosen=64;
 for(const size of sizes){if(size<minimum)continue;const small=canvas(Math.ceil(180*size/96),Math.ceil(180*size/96));small.getContext('2d').drawImage(c,0,0,small.width,small.height);const info=topology(small);if(info.holes>=original.holes&&info.components>=original.components&&info.transitions>=original.transitions*.75){chosen=size;break;}}
 return {size:chosen,complexity:original.transitions,holes:original.holes};
}
export async function renderTextPattern(text,{family='system-ui,"PingFang SC","Microsoft YaHei",sans-serif',color='#222222'}={}){
 text=text.normalize('NFC').replace(/\r\n?/g,'\n');if(!text.trim())throw Error('请先输入文字');const chars=graphemes(text);if(chars.length>200)throw Error('文字超过 200 个字符，请分段制作');
 await document.fonts.ready;
 const unique=[...new Set(chars.filter(c=>c.trim()))],analysis=unique.map(c=>glyphSize(c,family)),fontCells=Math.max(14,...analysis.map(a=>a.size));
 const probe=canvas(1,1).getContext('2d');probe.font=`600 ${fontCells}px ${family}`;
 const lines=[];for(const paragraph of text.split('\n')){let line='';for(const char of graphemes(paragraph)){if(line&&probe.measureText(line+char).width>232){lines.push(line);line='';}line+=char;}lines.push(line);}
 const pad=4,lineHeight=Math.ceil(fontCells*1.4),width=Math.max(16,Math.ceil(Math.max(...lines.map(l=>probe.measureText(l).width)))+pad*2),height=lines.length*lineHeight+pad*2;
 if(width>256||height>256)throw Error('为保留复杂笔画，文字图纸将超过 256 格。请减少文字、换行或分段制作。');
 const scale=4,c=canvas(width*scale,height*scale),ctx=c.getContext('2d');ctx.scale(scale,scale);ctx.font=`600 ${fontCells}px ${family}`;ctx.textBaseline='alphabetic';ctx.textAlign='center';ctx.fillStyle=color;
 lines.forEach((line,i)=>{ctx.direction=/^[\s\p{P}]*[\u0590-\u08ff]/u.test(line)?'rtl':'ltr';ctx.fillText(line,width/2,pad+fontCells+i*lineHeight);});
 // Color emoji and fallback glyphs also become the requested single bead color.
 ctx.globalCompositeOperation='source-in';ctx.fillStyle=color;ctx.fillRect(0,0,width,height);
 return {canvas:c,width,height,fontCells,complex:fontCells>=30,analysis,lines:lines.length,text};
}
