"""Plot every configured JEV bucket against the same cases' actual labels."""
import argparse
from collections import Counter
import json
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
from core import BINS, ETA


def nearest(value, anchors):
    return min(range(len(anchors)), key=lambda i: (abs(value-anchors[i]), i))


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--winner', type=Path, required=True)
    p.add_argument('--view', choices=['eta', 'batches'], required=True)
    p.add_argument('--output', type=Path, required=True)
    a = p.parse_args()
    rows = json.loads(a.winner.read_text())['rows']
    rows = [r for r in rows if r.get('ok')]
    if a.view == 'eta':
        rows = [r for r in rows if r['eta_actual'] is not None]
        labels = list(ETA)
        anchors = list(ETA.values())
        actual = Counter(nearest(r['eta_actual'], anchors) for r in rows)
        estimate = Counter(labels.index(r['eta_bucket']) for r in rows)
        groups = [('Minutes: 1–30', range(0, 30)), ('Minutes: 31–59', range(30, 59)),
                  ('Hours: 1–23', range(59, 82)), ('Days: 1–29', range(82, 111)),
                  ('Months: 1–11, then 1 year', range(111, 123))]
        title = 'Remaining time: every JEV bucket'
        note = 'Actual time mapped to nearest allowed duration; zero/sub-minute durations map to 1m. Months = 30 days.'
    else:
        anchors = BINS
        labels = [str(n) for n in BINS[:-1]] + ['55+']
        actual = Counter(nearest(r['remaining_actual'], anchors) for r in rows)
        estimate = Counter(nearest(r['remaining_predicted'], anchors) for r in rows)
        groups = [('All 10 remaining tool-batch buckets', range(len(BINS)))]
        title = 'Remaining tool batches: every JEV bucket'
        note = 'Actual batch counts and JEV expected-batch estimates mapped to nearest anchor; ties go lower. Overflow anchor = 55.'
    assert len(labels) == len(anchors)
    assert sum(actual.values()) == sum(estimate.values()) == len(rows)
    width, panel_height = 1900, 260 if a.view == 'eta' else 420
    im = Image.new('RGB', (width, 150+panel_height*len(groups)+100), '#f6f8fc')
    d = ImageDraw.Draw(im)
    def text(x,y,s,size=19,color='#233047'):
        d.text((x,y),s,font=ImageFont.truetype('/usr/share/fonts/truetype/lato/Lato-Medium.ttf',size),fill=color)
    gray, blue = '#949dac', '#526fe0'
    text(35,20,title,34)
    text(35,70,f'{len(rows):,} paired test cases. Gray = actual; blue = optimized JEV estimate. Numbers above bars are counts.',22)
    text(35,106,'Each panel has its own linear count scale. Empty buckets are retained.',18)
    for panel_index,(heading,indices) in enumerate(groups):
        indices = list(indices)
        top = 150+panel_index*panel_height
        d.rounded_rectangle((25,top,width-25,top+panel_height-14),radius=10,fill='white',outline='#dae0eb')
        text(45,top+12,heading,23)
        x,y,w,h = 95,top+66,width-130,panel_height-118
        peak = max([actual[i] for i in indices]+[estimate[i] for i in indices]+[1])
        for fraction in (0,.5,1):
            yy=y+h*(1-fraction)
            d.line((x,yy,x+w,yy),fill='#e6e9ef')
            text(x-70,yy-9,str(round(peak*fraction)),16)
        step=w/len(indices)
        bar=min(45,(step-16)/2)
        for offset,i in enumerate(indices):
            center=x+(offset+.5)*step
            for n,left,color in [(actual[i],center-bar-2,gray),(estimate[i],center+2,blue)]:
                if n:
                    yy=y+h*(1-n/peak)
                    d.rectangle((left,yy,left+bar,y+h),fill=color)
                    label=str(n)
                    label_w=d.textlength(label,font=ImageFont.truetype('/usr/share/fonts/truetype/lato/Lato-Medium.ttf',14))
                    text(left+(bar-label_w)/2,yy-18,label,14,color)
            label=labels[i]
            text(center-10 if len(label)<=3 else center-16,y+h+9,label,17)
    text(35,im.height-75,note,20)
    text(35,im.height-40,'Historical test sample, not a census of production. Browser/explore time labels unavailable.',18)
    im.save(a.output)


if __name__ == '__main__':
    main()
