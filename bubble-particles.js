// Screen-space bubbles emitted by the hand portal; deliberately not clipped to it.
export class BubbleParticles {
  constructor(canvas, random = Math.random) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.random = random;
    this.particles = [];
    this.last = null;
    this.credit = 0;
  }
  clear() {
    this.particles.length = 0;
    this.credit = 0;
    this.last = null;
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
  render(quad, bass, now) {
    const {canvas, ctx} = this;
    const dt = this.last === null ? 0 : Math.min(.06, Math.max(0, (now-this.last)/1000));
    this.last = now;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width/1280, canvas.height/720);
    if (quad?.length === 4) {
      const center = quad.reduce((c,p)=>({x:c.x+p.x/4,y:c.y+p.y/4}),{x:0,y:0});
      this.credit += dt*(12+Math.max(0,Math.min(1,bass))*10);
      while(this.credit >= 1) {
        this.credit--;
        if(this.particles.length>=64) break;
        const edge = Math.floor(this.random()*4), a=quad[edge], b=quad[(edge+1)%4], t=this.random();
        const ex=a.x+(b.x-a.x)*t, ey=a.y+(b.y-a.y)*t;
        const dx=ex-center.x, dy=ey-center.y, len=Math.hypot(dx,dy)||1;
        const speed=(65+this.random()*65)*scale;
        this.particles.push({x:center.x+dx*.72,y:center.y+dy*.72,
          vx:dx/len*speed,vy:dy/len*speed-30*scale,
          radius:(12+this.random()*20)*scale,age:0,life:3+this.random()*1.5,phase:this.random()*Math.PI*2});
      }
    } else this.credit=0;
    this.particles=this.particles.filter(p=>{
      p.age+=dt;p.x+=p.vx*dt+Math.sin(p.age*2+p.phase)*12*scale*dt;
      p.vy-=12*scale*dt;p.y+=p.vy*dt;
      if(p.age>=p.life || p.x < -p.radius*2 || p.x>canvas.width+p.radius*2 || p.y < -p.radius*2 || p.y>canvas.height+p.radius*2) return false;
      const r=p.radius*(.7+.3*Math.min(1,p.age/.4));
      ctx.save();ctx.globalAlpha=Math.min(1,p.age/.25, (p.life-p.age)/.65)*.85;
      const g=ctx.createRadialGradient(p.x-r*.3,p.y-r*.4,0,p.x,p.y,r);
      g.addColorStop(0,'rgba(244,255,255,.65)');g.addColorStop(.35,'rgba(173,235,255,.08)');
      g.addColorStop(.78,'rgba(137,217,255,.12)');g.addColorStop(.95,'rgba(208,245,255,.8)');g.addColorStop(1,'rgba(255,255,255,.25)');
      ctx.fillStyle=g;ctx.shadowColor='rgba(110,219,255,.35)';ctx.shadowBlur=8*scale;
      ctx.beginPath();ctx.arc(p.x,p.y,r,0,Math.PI*2);ctx.fill();
      ctx.shadowBlur=0;ctx.strokeStyle='rgba(255,255,255,.85)';ctx.lineWidth=1.3*scale;
      ctx.beginPath();ctx.arc(p.x,p.y,r*.78,Math.PI*1.08,Math.PI*1.62);ctx.stroke();
      ctx.fillStyle='rgba(255,255,255,.9)';ctx.beginPath();ctx.ellipse(p.x-r*.32,p.y-r*.42,r*.16,r*.09,-.5,0,Math.PI*2);ctx.fill();
      ctx.restore();return true;
    });
  }
}
