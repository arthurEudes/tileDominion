import type {Player,Unit} from "./model.js";
type Entity=Player|Unit;
export class SpatialIndex{
 private buckets=new Map<string,Set<Entity>>();
 constructor(readonly size=16){}
 private key(x:number,y:number){return `${Math.floor(x/this.size)},${Math.floor(y/this.size)}`}
 rebuild(players:Iterable<Player>,units:Iterable<Unit>){this.buckets.clear();for(const e of players)this.add(e);for(const e of units)this.add(e)}
 add(e:Entity){const k=this.key(e.x,e.y),bucket=this.buckets.get(k)??new Set<Entity>();bucket.add(e);this.buckets.set(k,bucket)}
 query(x:number,y:number,radius:number){const out=new Set<Entity>(),minX=Math.floor((x-radius)/this.size),maxX=Math.floor((x+radius)/this.size),minY=Math.floor((y-radius)/this.size),maxY=Math.floor((y+radius)/this.size);for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++)for(const e of this.buckets.get(`${cx},${cy}`)??[])if(Math.abs(e.x-x)<=radius&&Math.abs(e.y-y)<=radius)out.add(e);return out}
}
