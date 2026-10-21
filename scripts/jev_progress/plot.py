"""Export empirical target histograms and error CDF without production text."""
import argparse
import json
import math
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--baseline', type=Path, required=True)
p.add_argument('--winner', type=Path, required=True)
p.add_argument('--output', type=Path, required=True)
a = p.parse_args()
base = json.loads(a.baseline.read_text())['rows']
winner = json.loads(a.winner.read_text())['rows']
im = Image.new('RGB', (1536, 690), '#f6f8fc')
d = ImageDraw.Draw(im)
def text(x,y,s,size=18,color='#233047'):
    font=ImageFont.truetype('/usr/share/fonts/truetype/lato/Lato-Medium.ttf',size)
    d.text((x,y),s,font=font,fill=color)
text(35,22,'JEV progress + ETA: final held-out comparison',32)
text(35,72,'2,000 prefixes / 179 traces / 87 root families. Repeated prefixes are correlated.',20)
blue, gray = '#526fe0', '#949dac'
def panel(index,title,subtitle):
    x=25+index*502
    d.rounded_rectangle((x,122,x+482,577),radius=12,fill='white',outline='#dae0eb')
    text(x+18,140,title,22);text(x+18,178,subtitle,15)
    return x+55,222,400,275

def histogram(box,edges,values,estimates,labels,xlabel):
    x,y,w,h=box
    counts=[sum(lo<=v<hi for v in values) for lo,hi in zip(edges,edges[1:])]
    predicted=[sum(lo<=v<hi for v in estimates) for lo,hi in zip(edges,edges[1:])]
    assert sum(counts) == len(values) == len(estimates) == sum(predicted)
    peak=max(counts+predicted,default=1) or 1
    d.rectangle((x,y-24,x+11,y-13),fill=gray)
    text(x+17,y-28,'Actual',13)
    d.rectangle((x+107,y-24,x+118,y-13),fill=blue)
    text(x+124,y-28,'JEV estimate',13)
    for f in (0,.5,1):
        yy=y+h-h*f;d.line((x,yy,x+w,yy),fill='#e6e9ef');text(x-45,yy-9,str(round(peak*f)),13)
    for i,(n,prediction) in enumerate(zip(counts,predicted)):
        step=w/len(counts);left=x+i*step+4
        bar=(step-10)/2
        d.rectangle((left,y+h-h*n/peak,left+bar,y+h),fill=gray)
        d.rectangle((left+bar+2,y+h-h*prediction/peak,left+2*bar+2,y+h),fill=blue)
        text(left-2,y+h+13,labels[i],12)
    text(x,y+h+43,xlabel,15)

histogram(panel(0,'Progress: actual vs JEV','10-point bins; exact 100% separate'),list(range(0,101,10))+[101],
          [100*r['actual_progress'] for r in winner],[100*r['predicted_progress'] for r in winner],
          [str(i) for i in range(0,101,10)],'Completed batches (%)')
durations=[r['eta_actual'] for r in winner if r['eta_actual'] is not None]
eta_predictions=[r['eta_predicted'] for r in winner if r['eta_actual'] is not None]
histogram(panel(1,'ETA: actual vs JEV','Same 1,744 cases; includes zero time'),
          [0,60,300,1800,3600,86400,30*86400,365*86400,float('inf')],
          durations,eta_predictions,['<1m','1-5m','5-30m','30-60m','1-24h','1-30d','1-12mo','1y+'],'Remaining time')
x,y,w,h=panel(2,'Progress error coverage','Gray: original. Blue: optimized timeline.')
for f in (0,.65,.95,1):
    yy=y+h*(1-f);d.line((x,yy,x+w,yy),fill='#e6e9ef');text(x-38,yy-9,str(round(f*100)),13)
for rows,color in [(base,gray),(winner,blue)]:
    errors=sorted(100*r['progress_error'] for r in rows)
    points=[(x+w*e/100,y+h*(1-(i+1)/len(errors))) for i,e in enumerate(errors)]
    d.line(points,fill=color,width=3)
for i in range(0,101,20):text(x+w*i/100-9,y+h+13,str(i),13)
text(x,y+h+43,'Absolute error (percentage points)',15)
text(35,606,'Progress MAE: 18.56 -> 14.45pp. Within +/-10pp: 38.0% -> 52.25%.',21)
text(35,642,'ETA did not improve. This historical sample is not the full production distribution; browser/explore ETA is unavailable.',17)
im.save(a.output)
