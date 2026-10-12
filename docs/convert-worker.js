import {convert} from './engine.js';
self.onmessage=event=>{const {id,data,palette,settings}=event.data;try{const pattern=convert(data,palette,settings,(percent,message)=>self.postMessage({id,progress:percent,message}));self.postMessage({id,pattern},[pattern.grid.buffer]);}catch(error){self.postMessage({id,error:error.message||String(error)});}};
