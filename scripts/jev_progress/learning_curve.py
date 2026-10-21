"""Describe a bounded mutation trajectory without consulting the test set."""
import argparse
import json
from pathlib import Path
from optimize import joint_loss


def analyze(points, patience=4, sharp_drop=.05):
    best, stale, plateau, rebounds = 1., 0, None, []
    for p in points:
        score = p['joint_loss']
        if plateau and score <= plateau['best_before'] * (1-sharp_drop):
            rebounds.append({'iteration': p['iteration'], 'joint_loss': score,
                             'drop_from_plateau': 1-score/plateau['best_before']})
            plateau = None
        if score < best:
            best, stale = score, 0
        else:
            stale += 1
        if stale == patience:
            plateau = {'iteration': p['iteration'], 'best_before': best}
    return {'plateau_definition': f'{patience} consecutive candidates without a new best',
            'sharp_drop_definition': f'at least {sharp_drop:.0%} lower joint validation error after plateau',
            'late_drops': rebounds, 'unresolved_plateau': plateau,
            'interpretation': 'Descriptive prompt-search trajectory only; not evidence of statistical double descent.'}


def main():
    from PIL import Image, ImageDraw, ImageFont
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--experiment', type=Path, required=True)
    a = p.parse_args()
    baseline = json.loads((a.experiment/'validation-baseline.json').read_text())['metrics']
    points=[]
    for f in sorted((a.experiment/'evaluations').glob('candidate-*-validation.json')):
        result=json.loads(f.read_text())
        if result['metrics']['failed']:
            raise ValueError('Cannot analyze an incomplete candidate')
        m=result['metrics']
        points.append({'iteration': int(f.name.split('-')[1]), 'joint_loss': joint_loss(m,baseline),
                       'progress_mae_pp': m['progress_mae_pp'], 'trace_macro_mae_pp':m['trace_macro_mae_pp'],
                       'eta_log_mae':m['eta_log_mae']})
    report={'baseline':baseline, 'points':points, **analyze(points)}
    (a.experiment/'learning-curve.json').write_text(json.dumps(report,indent=2))
    im=Image.new('RGB',(1450,800),'#f6f8fc');d=ImageDraw.Draw(im)
    def text(x,y,s,size=20,color='#233047'):
        d.text((x,y),s,font=ImageFont.truetype('/usr/share/fonts/truetype/lato/Lato-Medium.ttf',size),fill=color)
    text(35,24,'Joint progress + ETA optimization: mutation trajectory',32)
    text(35,75,'Fixed 500-case validation set. Errors normalized to the incoming champion; lower is better.',22)
    x,y,w,h=110,175,1280,480
    values=[1.]+[v for t in points for v in (t['joint_loss'],t['trace_macro_mae_pp']/baseline['trace_macro_mae_pp'],t['eta_log_mae']/baseline['eta_log_mae'])]
    lo=max(0,min(values)-.08);hi=max(values)+.08
    scale=lambda v:y+h*(hi-v)/(hi-lo)
    for i in range(6):
        value=lo+(hi-lo)*i/5;yy=scale(value)
        d.line((x,yy,x+w,yy),fill='#dce2ed');text(40,yy-10,f'{value:.2f}',17)
    d.line((x,scale(1),x+w,scale(1)),fill='#7c8491',width=2)
    series=[('Joint error','#526fe0',lambda t:t['joint_loss']),
            ('Progress error','#25a17e',lambda t:t['trace_macro_mae_pp']/baseline['trace_macro_mae_pp']),
            ('ETA error','#dd8447',lambda t:t['eta_log_mae']/baseline['eta_log_mae'])]
    for n,(label,color,get) in enumerate(series):
        text(125+n*380,125,label,22,color)
        pts=[(x,scale(1))]+[(x+w*(i+1)/max(1,len(points)),scale(get(t))) for i,t in enumerate(points)]
        if len(pts)>1:d.line(pts,fill=color,width=3)
        for px,py in pts:d.ellipse((px-4,py-4,px+4,py+4),fill=color)
    best=1.
    best_points=[(x,scale(best))]
    for i,t in enumerate(points):
        best=min(best,t['joint_loss'])
        best_points.append((x+w*(i+1)/max(1,len(points)),scale(best)))
    if len(best_points)>1:d.line(best_points,fill='#263044',width=3)
    text(1110,125,'Best joint',22,'#263044')
    text(x-25,y+h+15,'Start',17)
    for i,t in enumerate(points):text(x+w*(i+1)/len(points)-10,y+h+15,str(t['iteration']),17)
    text(520,y+h+55,'Mutation number (candidate scores, not test scores)',20)
    message='No >=5% late joint-error drop detected after a four-candidate plateau.'
    if report['late_drops']:message='Late drop detected: '+', '.join(str(r['iteration']) for r in report['late_drops'])
    text(35,750,message,21)
    im.save(a.experiment/'learning-curve.png')
    print(json.dumps(report,indent=2))


if __name__=='__main__':main()
