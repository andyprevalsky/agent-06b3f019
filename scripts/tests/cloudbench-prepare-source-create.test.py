#!/usr/bin/env python3
"""Real CLI against a simulated native HTTP boundary; no provider credentials."""
import copy
import base64
import zlib
from datetime import datetime, timezone
import http.server
import hashlib
import json
import os
import runpy
import re
import shlex
import signal
import shutil
import time
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from unittest.mock import Mock, patch
from types import SimpleNamespace

ROOT = Path(__file__).resolve().parents[2]
CLI = ROOT / 'scripts/cloudbench-prepare-source-create.py'
APP = 'navi-whisper-lux-bench'
OWNER = 'a' * 32
DONOR = '683e47df5094d8'
VOL = 'vol_vwnym366kn7k8mmv'


# Exact historical producer bytes, independent of the tested checkout's HEAD.
# Unchanged historical dependencies come from the checkout only after exact SHA
# verification; the two superseded files are self-contained compressed fixtures.
HISTORICAL_SHA256 = {'cloudbench-archived-machine-reuse.py': '6d75c63b0ca0aba8a74cfb2e05256bb0c757593bb5babf6238170d6ccbff83eb',
 'cloudbench-archived-reuse-effects.py': '0ae76f2f78f7284423e09e8610fd20a2bd4139783032e92df7d1d11a22983b60',
 'cloudbench-disposable-controller.py': '2155f76fa604797bb1b5de224a4d97d18c34081b202c7fc51c555d7aaa3ae43d',
 'cloudbench-machine-readiness.py': '5843e509a64380711147b140c346e81622a2f904b300d3af5a247415f5488797',
 'cloudbench-original-volume-capture.py': 'ddde11af81f8200c1987648ad19b10dd5aa893fbd6e05c6a25ec0c7ea8c12c58',
 'cloudbench-original600-runner.py': '04bdee6bb94485f58f7c7305860110f817c7d37be23bfc198a5c82b62be1eb63',
 'cloudbench-prepare-source-create.py': 'fa6f6566ca008eac6af09e190a501647f9195a55ce62d09fb71d42cea0e1d3ef',
 'cloudbench-prepare-source.py': '310dd959c788d4d7aebd42564a7c69984eb1a515732c0805f6202e99e855ab32',
 'cloudbench-select-snapshot.py': '8037c6cb618c772a2753c1abd80500eef4e465e17cf39afa6a86949ddfb65128',
 'cloudbench-source.py': 'c23bc1f26cb2ffbdcf46259110df3caf71131361417fb92d63d126863e4f3a66',
 'cloudbench-volume-migration.py': '5e00ce80101dcb21b1e746f4d1a4de6fafdbeba6185d885e366e10a9cdbc1b54',
 'process-identity.py': '102aef0fa6727acdd6668fcc85c6189f5453f685e7a2dcfee33af5a60e824656'}
HISTORICAL_PRODUCER_B85 = (
    'c-rl~3wzr}vLO0bFq!=pWI|G;-'
    'jWA%N3oT}H;(PKm7J56b+I4`N*s{{hahEZeDvRMJ^E4IXpofb%<O*O&iRfb0*!uDS6A1&K7TWq6suuBpABx>^F=<-'
    '7J0iYR*OO2ncshN`puvJw6iJ~JN@x&C!gI#^ZVsZG28nv`|u6^-&_77DrR{EU*C<3RXMqjijT8=2oJ`0*)oqtlRRHW+-'
    'WQNIEEfp%P5=ABj|CwC}z`qwv0Y5#>>3yK+m(c>cd6;k5yhSqxN5;{8KhqMw2`%q2ph&!OeJ<?~JF}b&hZQ#cDQ$7uVE$lrIN2JJ'
    '}MtTV~5~0X;&Sa#_sh(B`*dvYO^mIm_ndO`$p;m&@_&IufujFo^DY(V&=>@X-'
    'SQST0~DFwNIRG+5*?%~mwbCprIjp2Iw5gZpSagRv(Q8om{kHvptzdsxhhMKoRUtRnb(nU%NL&2WreUfkp`La`W*XW0_omaF-EGS1'
    '5=8&1b%iQi<iAwm}(&F-'
    'Vg_%4T$?ur3**wMT4VK!P6(<n_xtL18ur)e~v&Wi=Wd^Rh1@DkyypDwOp6U*E@=mV4w_f;>r<owfeGVbeM)RSp81Mn}*SA$}HZ+_'
    'fl<qdpde*e8J?0`k7`krUY8`1Gw_-Ps~?0gohndrLA0btA0{vKb?vWfk<>dzO&ATLFWd;9k?pUy|)iS2wjp5_RQpU&T%M+wcL0g!'
    '_xY1-^8^0JuR<&9<s@qD)YFnj;z*LTmcCC#b>|E9Q%M!8%xsE?f}4&hPUY<`%%JOB0l_TOd;!1FsmoGBxGdy%h7)7Q&4TX!@Zm-'
    'C{``jfm(7+g#y`9k;e{Os+;ukW^>Rk0Xf1A<Q4cXX24gKUmiW|#Osem#GG0o}#5q@}G+cKfau;}`FLeO2?pP=7%!-'
    '@bcuasK?``~@@y1o~$_EAwUJb9{Kbm+v19M+e=L{o!%kisIv5Z+N)3JK8-'
    'w=;p`qLsNX5!hp1i@1dK@$EQ&Y3rp`l&hDpshljVbqub-'
    '@^e%3Fm__0L`Gct*7QMd@^AkApvroIz*~ub)_%J(v{agC;`S0(&`JerG{`%s5if_L^+{gKUfA;+6^VcuTBV54CU!Yz3^7Y$aFR+6'
    '~{Gu4#<_kpCj)2_9Y%#?yMw5I0ac5afC-|;2q)*}G6pK8xw0NEkZsB-$@ZjPX>UVnrADV}q*?hVf;9q@s-3H>f<9-'
    '+D*l+3fXx}cz<us#pzzwm)XZQm?m@UiAqo{U>XX8bV7fjh%ep-qy?x4qFfe*^TVmyZ@0$7TCx9Nsy16?mW<xOy)H6PEe7sV}ox3<'
    '~*`Ys;;xyP2U%P-E~!p5J!e*W^DcR5H*TFzlnCviHyUhqv&X<;cy2Db|kM`{vSj~orIwZXEjZ^~+?_4H{&&*nq=pq-CKFi=??K$D'
    'uoZnq6&X~slrL+5MgQ)@e_xM2W~mN6Hgx>r|Edkk#Aa=g4Js)*Oi2Ve|Ff<s8lJe!n_<|&T_H`;13i#|{DX+K|_BFE6s#FwApU6c'
    '*e{ynfYjb<|%AuB;|fCY#o);!qpW_dnr++~v$a3}CNoEAOc7+wPRL+?)QdKcNa%%k7%>G@(&EE=)q;&`<YFP^Xr=v?%j?$(Yu$Y#'
    'ZCJjf<Iu(v`yv7O;+IxqFSO1Op7+x)&vE*A8g2PhV0(ui9K)YG`xir}aeAJbVjOMU>r<;@O2u^7V5Y)3|*EwYc^h>8_~<CX0m98!'
    'bMP5x;(zJ?n}em*I(VFPcz(3J6I*?9TpGRAF)uNuTCP-~c6(f>POFkGACMVa0d#cjej%w-'
    'I0=K^R*e03SGW@EVZQf?bx$%$vcVqjmb$blIShwq%>bQ_6POkQBS<n-'
    '}x&C$^FPSyu*X0;@si3JYFgC(^{@XA+%Ft`$gsaQ2HxH5KMqnQC+_7R5m!9`6jW9$UhuO>k_s<$pml1R1U3B*@`0OQ#lBnIBGXmF'
    'FwuJd8stlK2$=ZklQuq_{^fX0)?GzXDo*ot_ErepZ?4*y}cK7rF{4;8n?WyC+8U&Qig@kD7?;KahUzoY18xq}BulMFi9<_ET<5x?'
    'cpnh&*nNc3O8&FnDM<1T5Il}GSzyrZdlNvuV6@^9a~UpISy@>3qke?~)*)V79ys{0PE#|7Qkb+3#06MD@*<;1aUf{KG(0x&PmU!7'
    'l^$0UjI2}{;5+#=N-'
    'a9ksx{2(dijYaXXT#HO}F0d61g?Q*7CA_(ed0u!%=qDenYOl>YC?TrBm$;)i5*+&&L{Ahe{|@9HF3|{%cZOm!3*a<$d7<&Gpl+o_'
    'Q7rME8MXAC<q}dWnso*@`QSD!R!cb8jm!9YOdH*9&kEoP=93KWRX&v^J%0}WB5lGEnrrslWzBAik1@>$cjHvEV6;OtJ%AKSe=v(='
    'w<{J!7p)Re9EwVm3Fw-=Da2OM%g!}0^uX=i<iNZVHB<5stU{|Z^jrRRG|nf(k|YuJ0ym+U4RYce8NRRvemu-UGzIdvfNOb1Fk_93'
    '|CAV4{>+D#=@VcXn+?amNPUv#v%6H$US?>Punjo^gg-0=KT9n8YCIY0^Ma~_)GP_58@?8zHmq;C$Yv!9-'
    'MTfw&G{tJ@IYFIYNSPZGoHr}BnRZ>O#~w9sy`W*H-'
    'MAGc>xAzD*(X)siorghtDG0O3gY#J=J)M+85yX4D{i1;5~@8FLS_AI0=^x3;)ZkJ?geku0HSWJ|Gv;@OH$!-'
    '|yo4HJI55?w<Mna9{Nw-cPsPl_1On!*NN{1Wa0>A*`!O$EHaX1X$qFYBHH-%K`BNxLn0cTtd?;Xp3KnoeB0@#S-'
    '`sIS3xbZ24ui;T0VSEdvW!X#yt(953@}-Q-'
    '<pv?6R9B5`z)!aLm5+BtRT4YJe#=KRx~kUe6N1PLMQ6s4vT8A><>5>n3e7I4z9$1wH#4<9-'
    'pg~Pw&VrQ1!joTk@K<3C7?aAs>n}mtW|L?<x^6J~a@oY}rh1Fq`*bH&bqd2BD7#t@RD>aDi6)z5z0gJ#UkDa>|&94NA^~u{-'
    'XH+XPHAScP7$<sw%UIo+{KYWk4m^HR%+Y5q@qg-W1}r80Yhnk23zXmCr750L!}!W}0aUOU!I$&`-diz_-pHne531YC7zE4F_!{R0'
    'S9LbbmKk6i?VN><S`>D*EC$7d?~SV5-zI*7HDL}u-'
    '~oBkhz!+~sU3|ffB=*SupK+%_g6kX;@+TA8jg!%8kCGk^NjRz3{j4o5}^4oM^1n?gai=PTe92Y4h%e!b)aZ5s=$Z5jN~yZaR2Aih'
    '6FX*onfBO@sBlBZGE?J3X?c|`eF8jyXmsH&1d1M_s6p#+y(fjXuD}G3LVn%Ffo`hCPq<HSof8ENc^MvdX`Od+X#Pc8kd=B>{~2`A'
    'L0tQdnAvr(WYbmy{T&^bu0uX0d!|dchy;x^T`;{{cix>Uh}dC18TM&=cSIYeq?5~c5MIZPUzTQR<Cpzta^d#)`6>i6F8Cjje+iEr'
    'W5f9M`H#*75l9gXrG8?c6(GS^S~kRT2!89v+)SP4fNJ(b;QxtR5qWK@)B_m_u9@X_l@`#skpvmnZ6j^fZ|!Nqy_;<96u&P_E`d;6'
    '^VtCKEa|p>I4ag1k)={_k$IQm^0N>%rM4wRv}(lPEmZ4L;-UIF(4>r*@oKGsjQZY7?c&7O8xUZ-'
    'L1!=1Wdh`cys8l1S(WM67M{=O@HlBkjnQSeUZDY_g2%njSE7xC2%eVel-'
    '(vzWI|kpUSDJU6+K48W}Oo?2u(2QDg}XB6@g`r`@8927$&JPdFhR&{`yI`trb9c3Ca0!t;|LhqtkRCRxI}k~>3>s=}_kso8cy4Lz'
    'O(;VU|@Jgijz*{4_apBgDIm5gw>??-p8n55x&u>?jn8kZ4ip1luhK#lTXE6^M4m}S+4C<_eDjITK8agc*>Z4{g!r)xE?R*eb?-'
    'q{v>(ixYjRrK;4@v$~#1B(vq7Ae~aB&@ZG=QsByl4Q-'
    'qQRkYzYiS5UX6c;}g|DoDVWs?#fMMR+ZtMp>8;vK;yj5f!?IwKt!K9fNGI|pH>tnIFE$5j~aFBw5;J#6DB)*>GhDt>U{*FnFGoNJ'
    'lFooqJ&*O&xFK(uMsU~<OP*1U<enTzTT*fz~Fqew(3YhCg^VUwC7`0j8)3vxO`ZW-'
    '|`jTE;z+JJttvqiO(pl{At^<W!!L>R&MQcVN=TduZZxlF7q7&X!ypdKjBm2`s((TI8JsxK}QoF@`Ly8Mhq_~C`I{wv}H<_$$F^)M'
    'TYJH@#l?z12EaM*2xyaEyCR^OU05${7)Az{ujmDos(irb-'
    '8;E39QWx~42Q73TQ=(o`c9cS;75(_~B7OP##rc1xKfHW(P8KL$tL~<Wx&*+6{F9?CAc<{^WaN?RWA6+JrSxJoYhah(MGW>fA!^M@'
    '0D!_868L`*K~bBn%$JTv*^ytiL*GBupzoTwf`mD_X8;U<qsfQ-Hyj}VpF4krHk&8EnO2s|AvP6rdU5{S>tA2JLRb&;#Uk*^1Bs>x'
    's4A|p4d^wJdmwL!oIE<BRRQ0@J8s@+29K*AGFd~L>|wDK364PlZ0ur1L;~9ZGQ-8Va88kbRo0Ke-'
    '=MvLxe+pQmN3ClvubzyTBegIo|Fo$x3i+qt=L}h5J>3sp&&C4JcB>Km7Ymgfg`}$WVuQQOhm$**TgqnN}lPesjV6jTZ4fLm8*r>g'
    'NPgoUH+M^JZxJLM2q}G0ahdBn=={rrC$!<m3kow-TiD}{D2;S)o*+b={M<kag!QWi0%;*Azb^nRhw(m3Tw;N8jt}Q&rsFIuRUSZb'
    'p}!2_(B2RC;@w&vlYg2=UC$Pj4rj^%-00!x$&9dR-'
    'S=gd3y*6sbUx<)mlTD$y%(BbF88CWWCg(Zlr7NUPyPT_)e+sKEbJ>ZyiF%Z-J;RrszS00@-'
    'S^42ol4Y@w@~QT+X~vql+>Sak*siEhwE(J%AGo$-'
    '4{!=`7!5epZxuG5#%r36$1^7CRfQy`0XNUIzGoRVXy?T&U~kj4l1K&UCyuUoWd?jM$SYG*D42Lg$^LzeAd$JV<<x%p5*Z3ASN{`='
    'QMTmyFH<p%>GYWSe9s1H5iGT0I0lh;*Hw;0*4q;vW-Til9kt1@Mx#Fe>y!PKe4zznxqg4qCKu~AsyYd|arsHd}-'
    '<^4Q&hy{9*0Oay{0o+fMWO?YG#V4;V49^+`uW@L3mtN0T(O(k%#_Q)wA9>)nfbT6P#kDyZe=qux`3`<KN<*3-'
    'JOucVmR8Q)K92qx^+LiJ$|BzZo>R;IctN(YZ8R9|tIvCf59UkOG?+Euj1@l;aj(jKVlc_z(R*|g8NMcJ&>)}p%b0(i4YN6rSLjQf'
    'dX8B574F1oHlD?$iRFN;o(SO<84lK5AO_@cW88zp0{1^U!$kcYj(#3ZvK8C`9UTRs`KuJzit#c{;g+4i4VTTwE$!dZip+H*_1c0Y'
    'm8*HaXf!*f6ZyFSCHCDx&!3H?)%)hI?wg>}l|Et3B6<gJ(rUK+83NaYGLxstqE~qKvhf6&sw8?1B1lCWqgLo^V3pxttwp`H$2z1H'
    'H)_*XKo2UsjPw@bR;%sP-gv78>|VbZ-X}O$%XRK`TM_C|fWoOa-'
    '=c#8O0mjy)W2|o&VJOrUUJJUuO)Xt_)8HQ!tf<rdn*3PETh89Ge*&xDyuOIF{?1M=l?ixS>&_)BLSweD%=OV<z|bBabd~_<8-'
    'D#i<W4NX*7X-*y~1rQ6G^B76@$RLd-u6CaV(Htd`E^UK~X(c3DvX!1mAK2F=Ma2!=>`3<3lD8&-'
    'V%49acgN9h0WbG%$m;?t;i3@8z6FIhA-'
    'o<?i@n&XE@jWL?s8wYqcOEYhHD&YMP7DX8zeD5$%6@7ka@^4|3xBU>q0y_@8Det4_4C@|sy@e=-'
    'R`<Gh&=q3qr$G)<#rN>VIsJ+L-Jw32e4xbbZ7w>FyO_!TbL$W7w~o%C_Lu_ixEXm>NATCdLG;(e143vue0u6ns9r<;Ax+F-'
    '4WH4!`N47;JT$M$!TpyWktZJy|4!juNusR~y54h5qPcPWa&Vt1jY0xo3ug|+c{I{jNz^?`)sH$A8Z*V^2@D$2UPN#<B~}P=U}F0R'
    '70Me@0J=l@8ZLDRjsF`8v6K7ijJKLm;4Y|}k%OknLHcVUs=msfMrbQI>hd);ihYBfM2HOHEpq<vYNl*y!)E|WpcVsV$|idr2jfa7'
    'X)@|-wv7455ZBp?*v3m#5kr@AMI`kJp`X4lGIVF?6onjA0Kb79t?^;jdV=-'
    'N1L6a6532u!y@x!}Lwv5BfT|s6?;!sJ=~K|G?^ihpQNJ3#vFop<H5EJj-oI3t`NjRfqfN&e_FB4o<2!X#FDWA28$dOX%1|}=N{<0'
    'g3jLru@7W+*%s80bn={J}b?6~OAL{%(9JHXvYw$vPNf7+S2OBrm-'
    '#hVbwp@}yBlWdcwOF~PGrdh9oM@jU6AlRyNt#|yias3pG`);}dGqV*i?i=vou|LOdG+fr=jr>4vy1chuD_P@*3pyH+rqv&Vf81^$'
    'C8GR8OW40v2Eyr!Y+#tLzw?$Y>C205SsHUG5?Eccp7kvHMsI<I%Nox{=>D_s-D7!q#_(}pp82zaaZG-'
    '%1NHj8$Au#N5v}YqeJIdgF{kjR>*=ddcDY|S_|!}Dc;N`_tEkOdS-'
    'n$sw_C&gjUP*F)Z1r27KW&sir~|BgY|VotC4j@J&Z*3ce;(uvD({vSlf~bQv&lCX<{@Av(mAvpjVAhx;m$(y<MY4YtysRs+@83_5'
    '@!Dkihyh;PjkwpVRec-WvJR%)t%+V^pGRDyx{rh~>KB(hat_@?*p=++AFEqywkji(@``8w;Wn)(kgBs@5C@cjX|Q%{+X#d_;;(xr'
    '8A96OmrS}Fv$g+ZFFqHL+WA1!OuY;hWnMWVu`;7Dq}gG9CN&_2XF%jtZlKC~eIZee_EnxdD^^cMbZOaZJ(w>aveY0`w=B5%^N@vG'
    'zsQNXcnn9p~pN&Jaj96&nBv+1dcWmcig{J8my|JxZ&R^?5j`K%~ABeWkj^mD+%SwZ$cr9KAwxoi-H!++?_--'
    '~|2ak=AR0zCl0;jc!sMe0@`CJ4nH<a04-'
    '61Ib5#ZmA?DONc|H>0>k4$&Qc0DqobwNSMi?(V+axy=`|e6j=kJS?U=*pzNyr+Z~<hdC>GDl37wVU`!1biTq_CrOu6*BHl-'
    '%lL;^zo);PJ^$(D>+|&Gi})%@s#m$~3TN0Emt<OMC<|261YwG~<C`78i6R!+Tau){l^v$8%}xi6>`ip6Lma{{M&!5(D1m{_aE{S;'
    '<$VW(jdV=^JaLid*<7WNsbFG@yr9y8oiLivkenS9A-0rBQ5X!9#wnl=#OK>n0n%GVT9~lBJ-hfRZpA;n`2~cr_{WzQKmGcBdhzDx'
    '^Vjgx&p1*^IMVX>r-|g5y0#-eSlFTJ6fNguuH=pJ0`K81%+Q4GJ3;tKa>r9|-'
    '4WRj25Kqj;@bZlp~V1iV&g$Jp55dKwjqT*VNNAv>VX79f0;2>h&Zkm@V0kwBV~*0yAJfJ<YK*u`1z|hzrOhX{PpvnQVBeQ4lmF&b'
    '%4v;kE>nV#Z^+dbLbnVF9|Mj!Gs7@OngX3u|Oc%U&n@C!4H}gHNhJOkD7ClS-'
    '&QPgZq|U78X@UM9&?Gdbx>_49a=cd0sSI@))+v+^$;MyGMB#!R%YgqX_>L{z_KmPo5^YunmqfaeDy&l-'
    'UUHetp5nX^_K=GcjNT?%I?f3s2Me8IY=$aXXT(Mh0YwQZiH^Nt>|rfd5RLAe?>TxR_yUn04~xxl<45cUI3Q{V9=L61@|I%V(AJT)'
    'm^sZZA%L68ChknE;K8Cuubwq8Nn!fY0B&{^8}1@E;JulDHSQ#KWJ@e^0xK2L`9bZ)dN5J;yd4m45=lR{VNAq*eJc1~*NMwE_G*?6'
    '&H?<u*9WRek=xGai5F@Q0)Q+b8nJ53gyX@D&9T>g^o+5p|TaXn;iVq=j#%=hC@$?)4pJ!y#=3T!Qpp_@@K^f7&2h*)VUaoKu8U=z'
    'US{+>A?_^S6}4Y7%cVHcmNN<0$!^=O(Fpv`&(uLru8!k*3a*u$!W#Y`}0VJwC(w+0?q(RJ?4kQ*{k_m&#x|OtkN1{GGSIVNbp0ck'
    'wfkx{*CsM2N1Cmm+(3olkUZT1{IJ|Nq-'
    '(ahbpU{o<!LuYo&y{qhG8R^DI!4Mf;)FvMjvFV|c_Om5<Kz5+@PD|IgtWXe$~Q8olmiXA4Gi(shXBJ4ARU}Tq@KN^^D`nLch@?%>'
    'AkSG2KFq)Ot0#jqS?K**fh>LuSF~{ifcY|i71xoDN%ZTHbD63^u%vkHA)Jv@3>qKY3gwJpCX}-'
    'Yxlh9oO1PJgv`dF+c!)Q1zVd;6c(C#TZ=CsAK&<y7X$AIIm#w8xA{&)y*?l60=uS5a3cjw>#`tsF_^u_tx_etE1TjHI`0rq?P=C|'
    '{Aug-'
    'q=TOf1))A_5n=kJp3kfD~@wEnPb8O}#vxQ?GKUbX;1kEeM&d)PZ>{!nY(Sg>Xf(qx_UXp2M2twy0`sa1lSFA;XTPPA=R;)ekNFS}'
    'Q*K&&vn>0Py4zrkAZb%%NeS#mYW%N?2T5rNotob5tVd&_q#tRKndO}u-`K$YlvxJo=W(h+6Df}*{6f-'
    '>SmixdQjc2Tw7z6r7(!dEX*zgn)JUPTkrLPZSxKjKdXn-N=)5REj7!d6@SYqAJnBM5|H_*CPfBMKzuZ-'
    'K3sbq<+ViJ@qKOV9lFp{qfB(Zg$kv|lm1Ijdxvx*M2%$o!3`J4bE%Y54P}A1$$0y%r6Tknbb?iT-'
    'z}MM=}AZ6i{$IF36iLZT5XJtHa2=Zl6?cQ!F)fNext9o>YK$J9V(zr!5Ni~Dp?OyTm=$>$7hbIk|eqibW71I@q`Q<Df&k)irwh3b'
    'fBQ5H?$M;^VUjYB0P=`~8Fr<mh4HjI`9eRr2Twu2>piJmzoe#*`P<EM}_Qz?J>1M+l;8k&RHqX3Tqr;Z|I)jHaud=?Eosz63%0Et'
    '7#{ot(cqPPj4Ru!+$P&c;o;Ttoj58uF}&azkyZgjgtsTN~*pl1;wapS``_C{;JIDhpL?z-'
    'PkyC1%3`q>oXU_<H7UyMd&&hCn6w`p`S_sEP?Y_QS0U6`#fAM`O*Eh@pYkC*)Asp{Z6ZY->i?15rlW3TkN3>6{*Hw;-'
    'HxM{$gqVS9o!@4?lxnJ{|{bDR>s;!BG-WRb}hN8L?abCp`BjuuJ<^2>Gms|CC-a(Bs(fPC-{}V(A^7R13;I-'
    '3WwPTGEVl3vZ58q^c*uiJfh?SpJwWnEx0voS_zR-'
    '&H$Y|O}R>_VHFjgpU)Gv7*V(I0;hSHFTXJSKY&ym_G^!wh_t?CXVo8`u8tH~GdY+R$YS*NkFXIy3Gte$RyH^{Ta5H`>p?JYp5kC+'
    'e7T38}vHUZLfD#$b3+bR2m=ZjEgR|D#zl(r}`Qz<wj$i=<?mhkoR!#BDR!Z$648ghQrDwe@QuaHX}&qAt?IFwlW@rn|@8q-'
    '<+F)eed7oaQ(A-'
    'q>eFY@skbJM&7|Aq`rAHHGJ(1&kGn51^i@8BuY0NBWo*$E!Q^%pQah2~T>M(H7Itx^84+8otvR*n0B51w0t??CYg2Yz$$VdnZetE'
    '6TS+O8uOvpn`5QpBPanILqylB&!_*hRr`$^pj1hLP0!gqWxfJ)q+rVZ3SR>T}$Q!ValkqE*5wwSvT~Q;TK?P2V9D#$lrha)Rl=1W'
    'mC4(Y)p3!KpO#o?|l&!0Mvl(^>HmB%N!@2d~%m=ji+sVC7)E#GSZ3B}xD6?Mvp)#!IxSqLpb`M*moi2e*^^XVe5kV1S@f=@XlBkK'
    'GK(SjpXM@&mAQsL?h&+7m%u=TzzJM3u<usa*wjXZ_ANVL{vtu?qs?LpRn*WNQxYXfqH1r82&t{dr9glrxvNFJE|m!Yr$#DmC^-'
    'XM(_?B|uA&$E1Vm=koRz_ec237E`I?$P|s9O9F=?rR2@XIQQWjRQ<es{iC=|AL9!abSC{0T-'
    'yrc2xeF7h=FjjT#Ixpw6Z58`bN7E5v(}W31{l*hvU4aK0-'
    'Gl1zSHO0}t;YGk@gW|LdZg17RUD4iHxgf0(s0&KPU96Z@{tFCB=u8T78BPJ%vlyHE0|vl|d{s8ca=DVbv$m8(hKpB^>zJk~U01*k'
    'cp3prgDQtmvBf?4VVPG~xPIo2EiP+RYy1^RwA;%|wzj3VW2qR!aEnr!)Y8cxc5o8gYt2Jn{tNcd+Z^j*P9*F^9Wc#})GLLKE4&N^'
    'lFBO5LAh5GwiG%~K~>h~OjC^KcD)*F!xmMfAx+zoS+^*i?fw@<WFtDiI6&(M!K%#-'
    'NyDwL~$JHv3<3C0DwF+bc4_?uygTIfc+qy5i_@;1E#DGMIBvo}>V{2-v&GLX*OIgX5Z?7D-'
    'uv?Tpaiz8knAaVw)8D4)gq$EHC^ElKy&Va0_I&o25o>1L8l}%GQ*((8ts`3KeDG2h(SS2vmu15;X+Zd^#mJphilBKvGBDX!0n^2c'
    'm5lQPfWGR&9mGcTMOwM%E>1Fo{?mMm$Q4#g=3ye7)-lu)^l%XuuV>E>ry{bQB{zT@0G8H9|N8r~wTRz9sA>j3snjB308RL-sNc}d'
    '!<7#XWfmWpr(5~rnx7)=aarYazl=r$_yU7R_1J^(%EH6~dt$jfR4E}4lV&V`!KdgyB#I>12P>1VwdgKf<v@@s+LS)r!6z<!oy4%!'
    'F4FX%Dd6jfl`Wu6kq=PoK*^s5xlKi;zL=yc+OOI{T!;#hxCkhpuQJR8Mb?|P$j2p=$oA!qpK0M{}3aT?h4Y#Q0py{TFK6-'
    '{S%9yUb?lT=zG<0LKy}Asc&|dQ)C-'
    '{@oLj<EIdeM}9zzI}d4AJuqZw=j%8%Z}?rY5Qnds0zYI+b)?D3;4YIVCD=RS`R5d$QJ6&<Lho!|#zq@b^y-'
    '^|irW|5yde%UJQ3shb9fMl}tQjnR&wh)3P2h<7yO;Ex9Hfrt^Z(?}SpnqmR!IMxp>_ce)ZFl}`l4}E|@G1AK6I1bq)U*F*tm4Ou+'
    '>6r`k_ptUm+`Y8hHUBS@?^V$0Pt^)L;(X|p)vdU0efFGih=VCtN;gncIVrW6uA(3VfraA4+c0WHj`@w9gbsMM$6aL8(HJYuibCiC'
    '&LecLYzy`-'
    'Al3|NjYo4Hd4OR!KYJ%~5o!$LA$CQ6V=f!Z?%Ru7GnEhzp*1?Giq1<SH!nLg!Zs6l^O^sN$qg=5d%+a27|^rKXB2){Go06VbKS?v'
    'L`?(JeYK`ZD;msKWwKAvG$2o;(|&T?JK1ge8`ffwB^qcR)cL8TjY<l~(UR%}VBFOLFXdDx;MV~4k~WvO<GIpbh1f9KOg*@zj^WJE'
    'bm+ZTTXv_nnUbRgR%4hHOXZ{IXYYOWUx?0gl5PNQ9rV1tuY#^-'
    'Y1;vhM_vm$y0JIIt=f}>T4fc2ue(K)^OoSEm3}?)A!>ffd^gKt{?*4Q=FSkh=-'
    '1a7W>aM`X(axX55Dr^NG%tl#JpQXi1{bL)&A16V_}a5z~?l<CMMI^t>l5xSJW8p$@{^C#DFmtPy%6hjs>wRM@t`PdG96)jX)suI9'
    'M9H?s2;(pL<iIPK$ZqV?G$pBeQh3bt|wy;+iX~ayxL2ua-'
    '5n7RHvH(24L>T^n1Dyv9mlMia~TSx{d?8XycpQVe!<sr90qeDa!Al}h<2m8?b!V7{$7DHsjJ6AW2TGpJSc$1V=zFFgfRx$jnuM3r'
    '@wfkY$fq_(0)#coH@<^Ke+n?^NW0A+Iv8D^8EtVW{{6i0%_Gq0uH?4SWHFq{u9HOZZ`=Rb!o2xSV=XVw9Kg+x)?T5wd22aYxEY3M'
    '=(Q&`=u)<BymqMGBE9lUBUp;M;}0GR(!qoh&r^Dg-LHBH8s6t&>`T9M;ycg3JkRdd7CT6+RIh`)N2)e?Pw>*b`eBk>#Qli_=?2B6'
    'eDawvZ-'
    'B~t2oT&PvIE4<JoC*_i^Y__4yfaxgXz$%lUirL{*6{&VK=b`KfBx8vBk#Zz8Gh>e;O|`NaRf_ZS^Q!wCnyg=wM<7+tj<9Y7aKVek'
    'YR-wNvsnpiKq_tR8$!xd{hHWV+FJzxTLnVR(MDKlCna?GR4;c-O-'
    'o(BT~l%gJn4KqGi61nN^#Bidf~LAT4W0Nl6qEJZqLQQ;7S>;2Kgc!I~~Gbc5_)%#x7XWyLlN;#<SI@)SSYrh8QV46h@k+!bnsJ-'
    'X2Vq5zY0?g8NW;%X$PXIEpqC33xj=*oqt{_CUsnV7E8<WS%eN^fwp!BT%_(3HEK`OU8MbRBNQ`14;%rbzH*e$f%&Pk$+i*iF=Z3^'
    'd@ejn!feuM#EhV;J4le9wxs#fB);N3v133r=%7AW0g&)yjP-'
    '9PhlW4+%CW;&6ehA2!>QaW;IVW_pLh!yGtwBB*8=JtW^7=%*RglETbK<kFv$o*JEqqoCcaxt$3bv!^`zY&Lh}cFiFh11a3+o-'
    'zqOwZ4RN3>Qr^SWp1n*R?X?;vH7xUJ2DxrFdWZ=xX#tnq;&QKY<+#2663WRZ!)!8H5iX+bqN(Ms52{_?+5j?D2>fwgn%}53y+if3'
    '}m(pI4a&fv*T8om7GPk>`YsBxt=B`kSXubFZF?9X1&7F8FSs2Qhn%l;q9_%Sk+9sQ~6Wkt~jtE{K0m<K(#xwZ30!PTythxRjt+SM'
    '@6$1kdwB<1#bcZ7x>MSP=T+2OWj$j%Qw=dx@lDF!fiBVH(@uG?scG`KZv<RWDguw<2<s_HEQ-QVFff2oUt|&c{8C(R~YhOg1DFtU'
    '@Y9(+m|}?2>M$E$SZvfFP+x4E(LrUIa$V^pS`{K_1*bp{KEu!F$Xiry`sf4G|U8Ebf)xqFbVkD+D|+M0hY$&yTudcB;8h<;?-'
    'orW}Gh8*CMF6(yw{hZEIu+Sr;9@Cq>@sYE8K146oJ{!ScIQGWYBbE*B8DfbiFiAtM8W>I~nPg$LM?#lCAUN9GB{d@wn@DpC;x8y}'
    'xWaOTmqj_Zx0^ov5mL(M{o<C)#dE~)5;lPV0=Z(~fK&NWMy*%(c)am&ak{0jL@j0dG=7>!uQ%{t|gT!OM)=vB;%$#`&&_VZa0KU7'
    '+0t7VZ6F(-'
    'd<uXqm@nK@c32ya~<W>qc$cO#s>wXmAi`Ii_#ZVXo)i~C8WQIQ#pt3Xk6Z5SoT7emHFrg*1oF0;uB*;vqjsysB~d()~LRE~F5EU|'
    '`A@m#+o#Ukf{btd|V?BoPKm7}q~Aged&D%0-Lf*|8!N)kMh6a{J)RGApLzixSfP)1^5&Ute7Q_p4-'
    'I6gXsC_4eUS58Y?dwJE#rN#qZ?UhCdc*B2)8r5ZDjWLENVUuvO+uc8IZlAqaGl!cC!4rG~!iZaOT$n2u?bT-'
    '<Cb%LwFI|h|{L8=2mEc&-D*ssfz5K>Ay+7XE{-'
    '_X)r?bM62mVr%e1&wXEW?QnoT*Ej>}Mvn1~6tWBQ=+bWw>e|Q8mEnHfcpEjQ+SZw}SJwvk4`0uhdxda8FM{W1s$AWhcK>2F-'
    'M0)~5)eV%@AgfAqR_C_-JBTcDHO-r)x5T}#bwC|uzWliiiN-`tx2D)jkEV)wsHgx-d9SP(pdTJQ=UO)$tY>2Y-8-'
    '?i1o5WkMXKY>#SV6(9KM~O4A)h4d@6BRuOS5dca*Ik)jp0)pH*8Zoi`6a$;8rQpu!vUuD^ef^Hj46xFC=&Dn9g>hcQcLAo;!yG=b'
    'YGi{w10~+od%}6*?{a~DTxCNt?5X!Wl~poZA0Ic+&pV)+yNR^Gxn@6V7FoPN?IJ3;;1!MGu`-'
    'yR|jC#ls(z?jM5w&h*aR;$3dg@x!&w1bI0V9e6Vcm&a?q8yUWHCjJi$r8{opth%Wxu7<(L94Nk^w4JW-mdfJ>NWqTphYaoPrP261'
    '_IeenL7@&)x9Q}W+;8u~43}LCrM{3z$Up(?y8X8BlH1uPAd-'
    '6AEk7svqbD<esefd>pFGl`z^ww66iADw1qbp6h8Sf%}h8BMvTc+C#vKgW`n-'
    '8_QKd>NWGS`Xv^n%RJIJK~(YS|hlx!U$d8**d_e((;crHcZ|5+~cdcwtqm{K~2a&{j_Q^z5MY6DOo1CW9tVDWx`R=f+`{!43pwHF'
    'XSTu%Y0po9lqUahky{T(PFU7lXIqZi2`Slh?=*{wjz;8ksj{3^NFSrsA|!hy#YUO#9>ORk11~SMKEOS7ZP$39uMDp>3JKkl!rJP9'
    '4_PrxB|ndYLbW`6z=w8&zwKR%?o{Y^|+ooh@zk@p+M2PXYOn3ZtdgZb)v$#L%og=uT2L)wSmsMb9dc$jXCbs8mCqr<6!qU=c<A{8'
    'my0asJn{Kt7WdVzJybYVR<8Z-J#)R5W3URTZK)S~IH<YXQUp%Zm`NJk0w`F1^C&G%bd-'
    'u}%`TC%SVPFAolJ6=@xu*dE%CO6_v?22uRHZDPo6OstEi8S`7aP9ppX;cK;}=OrTAwlvacClp)A%&dYbLf@?CQaf-'
    'd*G0Ep3%8JT`${x=6jcu{-q3c({$uF9Ue0(nC-VX<vg%@1SrET+Bi@xm%-X{9wN7c?)a{7eWE}`~3wg0RYxOhoi*fX~+Sk=B-'
    'p$WsJ0=~<VO=K?l*lX`6jc~+vt~%gRm?_XKgnOLW(esqrrd=qZe!l3bPMS3wVxmr@u}3+u5E=GW@=_6+p0p_(s@_ER_$YRVXAyj+'
    'DFW?RY6*sSgKkTTq~qBOn3t#Y=Gp-gb$NR!zo~-'
    'Q$J|)WJ~>oBc&H)s&%kh2+6crs|>)c(#R^h+uzRN7u+P3$+M8rC!asuVe5hR*%R6gEurX(3}h5*Z6<2&Tyf3jdRl0^X*yva;@lH6'
    '<#x&^)9(SrO7p#bOhioPuT-XCU|p<m)r{KFXGbSPNj<GjCKe*AdM(r_k0?I%;K!xgKo^ZBQe?zu&aw=F*H-'
    'q^2*pe^e9Ov<HhRWcg}dniost}ilX<HzYkIG$dpKs;eae0b_N$Q6hgM#B?vxI+QxgT^U?1xySJePH6utV|S-'
    'z>)rYr@*!$A+IO_ZDzAapZw3#$KCeMz6Ww`S02RWUKv#WGgiKPo;bTl$u?s*WB^7<?l9bs~%nN=gdKiqbVvm>m2c(5HF<Wb43X0P'
    'aPLR(q+`aaB#VPeqbQ)p|_KHtUa7R(#hhMw_3iXrT=x&$h^drN!D{NBX5fu_uRW|Dj>p971fPfVTj>Z5@KXx5c*cBjTVLs=$F1qw'
    'swzUBo#mQt6%R-&7>qza+I%uYam7Fyy^+C1Rf{I($-'
    'kn0W5N4G^zlQe2y`l(o9X3Njg;2NAPcC8C#`t0JGb>h{%nA#~!cNRsq`2DMeA%<*Ccj4sO|+KJLbvhqpAZrTiB0wPAe<Qc@3X27('
    'x$^jCpj1X)tZl!Fqf`5V4EhOh^FDCR@TL1~6Ae|*2ObkN8wxx~1a;s>$lK*pk7ettE6H%c(TI4o&i(#@UAs(5!ko#J}O}s!)cPiS'
    'Zvwgyx6cMJLN=Fr-zfHC@QFziHTiMu9p@JjKBof`Z#@1BX<dnumR~$7!ZW_Wxh=Qtm-I+nV`0AN;-'
    'BizfPkr1R9dsu4s~UNxc#pM()FLW2Mv@|RLQJ=*lNRYhX_2ixWMV6OT_<C!z!u3M*?c@)N!NG{@;zi6??#rf_o_40&66sb;fwY^R'
    '^uGoNQ9;GP0_b6e>wZ{Jbn54?XMT_k?7m1B4!=Nrfg6))p;~Yb})~dZW#!2OSEw?e%W8Iw@N`Kr!zGob!k_j0Kz4S4TM>w<|FDA@'
    'U5%=;$@(>+2>W?n7{kOY|C;%AHMl-Jvd)Z`(VW&Zn#~|Am}bOT3Fo!8ZI}L4~kU%Ae(zR_71Vu%LwcVBlK>!QoTtApv#GwL^uk6o'
    'k_1|#-'
    'wTLxGRKm1IVa!g$@d=;EQtCtH+ZZ2+p$XP`mUd|J3LmHXRb4h~pC0NCa*vtD_+7r;DNK+I*@i3%PzQh!avyIBmkd0)|#PHVZ>QwM'
    '|I8<mrX_V!kPnHa>JaFhrFva&xOEf*A8do%+G`m9XDC-Vz(!0~}E%347SLBH=!;rN?}5<rQB9+Q{k+-'
    'V9#h+&b_gIF_pYotSduIPuMdN>>_R2R1jsXrs0OX)W1nMYScV;AQ{{vaUj8{kgjYiS@xoqk3)pY|MV;ZLhfqf31lkS4ug<+6g0uY'
    'K(TccPp-'
    'K#?gQSRh4E%Y&NWIG(iKK4m6pgmAb_0Xi*leO3HYyRrU@Csivs8N0d)Y@Cq!QQqJ6$9Sn$WqE40N0`=sQWB!d^TtJ4{3*^e69sS)'
    'oQ{{8s(wm0J{FgX9YbQ;I#lW%q=^D<ACDz&i+s`%xL#EqQ_+DoVK{RRWv!J3c80Xst=Sga2je0dpEzY!)4MFNrlW!o?0hcLNlqN-'
    'W@>ZGKIIh6Y8CBDVxwuC0qrbJ-CT1Xml@`|}dj{gy^dJ1bG#h!jdn!FZin6nsX60?8TXc_(n(KmgUEu;d?Fb2jek(D9{&r*y=g9_'
    'JBee|)B=jOEmGESAdI<bsxw=Z^-'
    'ddA4YdFyQ>*u4?oG#lfSqB=dd_^gw6NERH00}4g76u9)4=;1E4%g&NpD5?BN1ZPBJk=nTWuZ18b<Owc2yOhl7CE)OFNBOpnMCG{M'
    'mfHot){Ig9W4Of^4M}#^q01+$&GGx5~3%mq32GC#NeOVr1Spej~D0ferZMa_siE8^5;*#zLle^7yKVHOEF$BXj5l8p`AB+1BnNZb'
    'J+;vu7tps;IE6jLA<RbBzBb+UA}JMcG2U}C6cCi`J}17MR+UU-<QjLdj4t5x<0Zqe$)D93xWQd({KL#r=3-'
    '~*y)dF7%3R(N<cHEqo9^i1_En=Nwcs#$V^K_%gH?lj%lq^<ifLqOL)f!UPf*(ETzVo+z*x$y3C`Dlr$Zc3kG<~YfM%(pKJbJrG6+'
    's%zjaxYQhg~hx6(Ui&?Qi<qIa00g)Vf;FUtZFSU{^$|kr9<$*IRKFkbteir?Be!;#N3y>6NgYjg{$gt3hK<2`z-'
    '>J4&c0<$GY%{F+SJ)D4SK@8lZtFbqq?lIJpj3tlgZ3~;CpwD|uE>v2&pMV6&;ULdt`@|hV0Nl;Dg2Arh^Xdg^g%T%f$9A(<u&oY;'
    'MKIa%dzMSdY=^K7&+64Q(I=ZqrcCGdXuG^i)N1QLLX+!n?<p@zJV2MryET$cbrFv^YV!?2eSH<{WPB8qP4RWc}d|yqn9r_(YqW&M'
    'FGM91q0jC?#e)+tWi-R;e!46Fmq3V$^p}fo@euHfDJim6FV%TrmU^|JnVL(fof&kbKwZ$7|dv*A-'
    'Gsvqs?mx8`#p$vz+1{^TyHBoDz*GUA98xsObM4Zt4%S#(0MHwQ>KIzPuI5tk}6KWeKNk0{cF|^iY(+4*F7|tN85{kZg<_eKs79d3'
    ')5itQp)vgavkE8Y%ohC8Jp$l>@q$ZfYuNOGlH04>Qt7rs-'
    '$}qzWmMsu4p@n>+^5F7;I1zUIMb0EEN*QdQi{ZzP81#}uwe^P?!$$f^L19`-'
    'FYqBrOzhiVM{O8+)}EX1Fv2{peIm9f9+da^&UBAEGMbTRhPz5Ux6aJ86VtsJ^L{D&@B)I)V-'
    '5P+nZRT|Ee3NrwMVl!PSx0MgG_ZM&8o&9*ewRV@~`u22u%~zdP?7lcZd-'
    '3Y!>+|<p_cR;>??{3ZOAv5!RPs6K?)~etx9@*?bFp=Ak8q3!<bL}$s;@BdVfOajn~U@37w0c@>0(^f=lJk=FW)~Jjt;sf`@>_DYm'
    'R%p;o;uyX!r1-oAZ;s-J{-7cGNrB??Rgg+1YPzUj6!u>I>kQ-hG_iPxlTFZ)Zoh$J6N@xgWsuMepy!`~)tf*{9v<>|}wx{Bri6>G'
    '!{1(AS6i(YH~ryQ}~6VfO0$$Ft|Zr>JShg$<8Kz5Za>+dUq1cl-U5z2pAj{@(81$w@EI`op8{(f)DXJ35HXmuxgj-~V)m-'
    ')DoP{gc6Hf3%-xd4I2WG#Vc4AMK9@gT0gC5&Z6r4o~{S<CBBE(O&=Xq`P~N?ez}2y94-ra4h=$f1%&kXRn}B+%r-'
    '0po4p!e_FCfN?R~bZIrKP<#<r;V8X&3Cdr!n$ZX$lU%n<-GB*>G-'
    'A^$@z<Kot2mSq%gTww{_aN^MkNWxX@qTY_w?7(<dizJayGNs5uY0)L-'
    '`gK`M~9;mSn8mEob`_md%GuDrVBbLO;$(UuBQKkY(E=h+0jw|WO&@`4-'
    'b2z5kjW7w?7yhX1gc5qy3|k<AeP8=&*kTAm1AfPWngt`QF}1chDdD{WHsGy3dFGy}f+z_~dxEI|2aj4G#0{aBp~Ua&j`t@@#LvcQ'
    '86Q8SL&K9Oi>wFCXmh9%X~>!3YrWq<`Xd-'
    '|iiq?C&1#A9Z(OE_+AaUT?Rf$+m^r$x(j*;2G@ipA1j(!SUhI5h4#@(q29~8o`$LMo0aF!(P8TIzX82=A+#l;59miea{e4@&5*st'
    'SsTK9j!`W(`^YQ&B|l_UaJz(0or`wpkk{m0Vjl#WJUocszF5<(c|dvY|mEv$NC?y<fSP1sLJ<X!He`Zzc00GKVu~@hDjrC;rTp8x'
    '9|)vd0?$)svfUW{>L_LtDOTX^FpJ06-'
    'fQ5IyFdT(njKuffU}`Qa!3;ManPZ`6NTPO<Bjsq(`CBBNHxEYh}NZO7;N{F)AEkPXP*_V^!N>euvT){}|5-'
    '`vdFU+Fw(=#?o17pA7VqK<tzL2moh4SYb$;{&6jT%&_FH7AuFGW`|4Xastb;^Co@w;?3(<zeoSYzh1xj;mxa8Z~nvne*OKcH_v|#'
    '3X9~uLDh2+Mx$XR$1yzayiZ@ge|P>P{LnM!I7I%9z(6N}-'
    'l0pUQJaQ!udPRRFk1#?y1^L?X;~w*$1M72p26C^qoGDR;9KD`%(LlfrR)(`zeZnhWJ??VL@*34lpmN%=8)5?Sq86)utOy*;0E-'
    'hT*_Y(X!5y4xrzcj){szsG$^VdBTD7Vnsq@1SZ$XI8Jqo4d!tZ?5_wV%%6x@MC{1D+yJ69Pk4OU|_Kh%$OFT*QtCmYede!je>1cx'
    'Nqdl+$|3JN6kp(w+rdx`$ho|F3ncft|ZDJ1iYBmN&FXa~G24tuWYQgy+I7CMma-%}xWrK_#y0V+8V(t4d+PTXLXSTwphJ&iT7gv-'
    'RK3!s+xuQ(13VCkX>Y-'
    'YrrPl?Q@4P@wh_kA>%DOLk;tu>^|3|6w*YymRWrs|MR0AcxSuW>gjIap5i**SBcy&{hORXaR98U_EHa@~Tp|^X~>B9f@=z=)y#Sa'
    'de$3I<MynT<O&{xrt-'
    '41y{6(llMjd<7<$X+z8DLhV(@do`^EQa1=z>3Aa_iVJtuBTKS3Y~qZc8ea|LtL&2xnPHcct;m7<lFpp@h;~SxD8j@=-'
    '~47yPsfeVB<|;LplNc%4oGQziTV{Hf`44<gxw+of=lE)Qgx3iLGLYG{vkyX-Zu?`a<~K!J=vyKdMnEl$Py>S0Hbs-'
    '=DodPk(*)3ipw4<8)^SV?lL%V+SrkCjx`|2T5pt^N-1<A%1*!_V%a$@ha5+XmZ~f7dxsWX9Uy|Y%K&0vMG>@>si}OSc^fd&-'
    'f=hnqPSfP-EbK8e8P73#Jv=>-'
    'u29%ZpU#9=foJgWvk7^mb8vx>q>V_zcHLq8*nrw`e7?iPLtsaI98@iPLp8NXoRJlmDsGUFsdMzo>(7oU4R~S#{>`)Q~g?kC^CzF{'
    'u#sMA>y=0;Yr%89asSF1+(^K|Qa}@tLzxr*?m^<a<F9PW$41o+G!O&F4B$c1H!b#b*Q5Ti3k(_S=RUN!h+1{1PS<eIY{fgw7lIRZ'
    'gM1Tp`IdWzbr}e<y6yB7Vl`2QD=a1lPcB7riPhvM?X#q-'
    's%4CCKdPtmdIGeLXGRro&GHIX!Qf8gO>~KuIcMo=i7%1zOqL<(tC%6EJ?}15w9Nmn2&jMKsA4*Lh7I0ELxXMCq%RII7+lljFD*g#'
    '#-'
    'qU|_GN5Fjdi3XSs!u4H5JMP+Z1YA(7=NLH*f9AXAeI@IjKNFU)6@Y3Gz?w{7K#6?r$D^0dZbMdI%!dX;|kqXJsri1j?4($V2_1od'
    'jQiGiKi*WnlIJ=$!Pca^7H>X^ip;Ef}lCUjF<5o($n($E#!6AdqOw=0NcmcJkuedffHZNU06&Tfm&CKQ{I%>+tZS`TL4l7>n8rr0'
    '6bvHvHLgUSQ+WMBLy4;eK<Au&7an-CtkNQ0|Cs6p7MHEpq0l8*c%~)8sjUm$VFWy4!+S1nFwM~)@JRl-pPQDh1xk*nR_+MNWgWG)'
    'BR%E!Q=L>$z`W=;Ll8H*YSXftzwt`ToPWrzG`7A2|ESSeeuzVu<i1|D@d;9jO3<dj=<3*?07Cn;XP%%l&T@U!dIj0yw+s}7mCVFf'
    '$su@toNyeRD6=4M|&nJ2=el8`|WQ<}w85k!M=QU^d;CJ%5&DA7RFsTp^Dy*W*s<?8HF>B%SXlA%*JLj-'
    '0gcs}QVDAs6XcvzKh__;<r!s_BASPH4McBDg3rE-O{tXp=!a9_TDaO}N@_cCwujQmzmd}*=YYxnM-qKk~$gVsbmjmE^mbi)>*mN?'
    'lE{3kVy>w0YnQ`F){QT_g+4Gkdzo+lc-=Dwx?d;;^o7d^PH*YS&2TTPq`yF2V^7h5ccd;rmg%#g-'
    'B9OicASjMl!FpnH%z{(UbfZ6U#;8ZI{&uPePT`eSVK*gPSVaJwmt9q;$f6OxJ1*-o5*kPAHCh^`$>mi`d;h1jF-'
    'f=SD3qP=f@Ou(x{Q8=qiNkKgFKxDG#@6VL{KryfDleQrnXGPP*M&a#_Sq9Gq<&D)=l5GTC)Z_@RJr|K6h3#QpzQY$1RX1H^gL?`2'
    'x%MG@D)$lpDB*+e$@5261~civwe)K1MI`LB2qP{_?)XMgncokaeK)36+2{ljkR{eq76as;=?pSf%d6qk%coQD9fvo;k+}!+%np>@'
    'r5doFB8td5!N~>>wmLRdV3d3cWP&_w9H#j2|j`I5ja4EqL-Bv{9&Y#!oKIjM-zf7dtO0?>oML;~S{SrJHGg`9v8CjOIx<ARt^hk1'
    'Qar*7Qs{0{|0&H5kLbs=1@C#A$&pu-'
    '!G?xB#qnsM|Skb(&Qa&=$)aqApM^4rHcLWCr?{Mc5HuiGdvD!P1`SJhP@xlq3Ya#Wh12alAIscS*Fai?wNP^l9N_YUp3q(oQigmJ'
    'szBU85Xel_Ovr|M3|;S+beZU^L3f>iQI~4Pk3zN4CW^na!H;#dsKDJMI5cM*T5JgtP1S%yB<N53zS2gmP5kGo?Xm!2zb}#HT#J2b'
    '1jNI!c@@Fn+OeIs1xAR(?qAFAz+hJAw`*-vmEZvJ_Y$r%KW55A#NH0v00v%{UoP$7HB7-'
    'K&;zEm{khVhR#ynbKFzsz@54$4=Id9+Da!1MOJdE|!v?0wc3pu&<JxqIN{$*8V(|uZtUm#4%~?z^4do$sq_#VcQ@%T*oa7D11aZt'
    'j$3p%n_>yr%G^=j9xR<oT#X-'
    'V~^o!awWn?8e)RA?O_Oq&&DAG40omx2QSbJZ%=GV^@^lJ*cyHrhz?ad%oqV)b6q8;yDKl7i5P!Yn^E<WbE&o|nd*#tL_c31(N8Z!'
    'F%3CW!?J0ZbpA;#&;dt(EtgkP9g_{Kq~%ZxT98!t<L5*k<_v&0fzxbO-=OB)@I9YSSHh+DdQUiB44=4%n9$cf64P-'
    '>a5HQyrZ5Di0+)L#L^PyWD0@~?O#VORYC6pp_sJ6QG-l}&KSoqg=S^*^wnz~qA9QHqipqXLCnP*k`WbFce`@imL-'
    'w9hmS{5!CsWCgIHXRE(V%EL(N^QO88rDP5dBl@S(xg#a+K<IroPthiu_zZ)xL*@v=k#P8|W0zy;@ZkIvod<33>{&jD-FbR7P%WLi'
    '>$4m++BRnju<RnW+8sK+cSS3wV_f=s}FLESA|MRTZfWxD{n76B?rBxNW8t5OW-'
    '<{$$NI$o2IVq~*RO@&~Ng_=2YH#w3BwV)X=WQ{rrz7*jaq;TNe~RbpPEHij=8VB@CwGQ~rS8=NhR>3Coq`YMG0fvVYgsx4AL;pLm'
    'mopPC}fkXvIWPwHPGz@Yw>(IYLUpB{)iemzck^1b<(d$A`vq3hCa`KD-Imbq8q60S_=0O3xPwDuLXWG)<(mk?@AtP5`xZkqdytu='
    'B2P0^HqfkyO9H{1RpFDxJ^EK=!J70G^1_$fzO#PaCj+-TW;gNpI1SfG-3=THbIDQEv{>oMVsIh64EV!D2H^#L><y(NOr{aq3@-'
    '23EfI4XQ6nK?GuJ3H=(_hh@15MxMYBU-'
    'T#%MWUFd2SEZ=a_fqD{2iG6e`&R#~&gA{9X$Io~nhqCP~L3mw|5a~xN?km;pG4<_WchT~8pNJdmWa;r85CuI_((+k7k1(kDROrDb'
    '*Qh7Gkjc69(4XB{ukLTxfa4SBB=cF^h*g45C;3?5<p4a7P9kP5{H%F@fd<vUFGQ)$EcJXRmH)`djI|0cYa%pf?t%l!o4mCg9p5N%'
    'Qt7_V)b<~1;{nxZgKKHy(=M3`>(MPpaGiei?O<LsF#DI|-'
    'kw6ObJj`)kecpSBTT!ShaztnbrpE6pEEvs64xKHR85ReVIcMsRL<OC7Nlzk=s!moY$)fYk_@8-t-'
    'A65}5Vg3)rFn~q6;ax9&H@Xc+0c+E_6+q8gH13Xq`*L?H-'
    'V1)wwCc{1;*(mF#lP5boKdg|ACTz<42Uwa6H4>Up!e(h~=MKewsKZ&q+h5w3=d4^jggcS*SuK+v)%lSK^(4x$S@=s(Co3meB^Fct'
    'U`*Yvdz~V=(r;W8Vljq`;@bHnkwpz!>F=d{$EzO@jtnUD{E(UI4C7JvW2U8?kZ~wm7@<z>E0}#A5x0!fQ#KJSp%tyy!dim~t()qC'
    '3iPIlHsTE#+A>kz|Y*vWlP&2fxC?qprVjWd&1&Ac=Gwi7bY|anhn9g7hHOp9=R2DWJ-'
    'G%CrqAJ&F;@;a5(6N|77Xy#{nqGM$q`1Jw=pClIlZ9y>Vt@~U=XUur|_<&{&pl%zrGhzQq_^=`b}J0+#>r4O4{&1G1_I3Uv(C~RD'
    '%?k+vyIdrd@+cxc8HN(U3>)o)XS-%V^nbr50MU)aQ6eY-YHaQO_y+{!YJ-'
    '7Xao;rsBbg4Fko}!5caGd!sPxoL7m2h}O8CRF=Cy3EQ1vA6wLESnq&Z?VkVm`uAeg5a1j1r&WV#tDnc*>8O<~}kwFH&{FRf+<QjC'
    'Hk4o2s#sm~grdn&8J}fjakWX%5__zD6nkU564q0ZPaJ6Y0Qr-'
    'R^0(3l}G`{4myZ?xYsdqx@B@!Oy7I2GKwkD8bB|7~QK5b9g=CiZYR9OkqFGQ8dG@E5^5tD-'
    '|DawNgM=Dequu<!;4{;q4EN0r=s`G+U?g(QHX=_MSjRtf0dRvSW4_#lGp97>T;+1G#;4t#-'
    'IO61=eLYx9^wBA7UUn5d+}RJCMMY{HSmV2W^`=#R;g-(Xt^Tt%MOK7r5pf)tDE#OeWsD4h7Rv6#J2G?N-'
    'q>XF<eNQZ^$Q<R0O67jF1wh8N!*6NwOgp!<GL_QMT8*7F3qE3(<=#%q=vg^37w6VuAk{OjHc?;C&FaZxSi;diQm46V<>TPO4hw1X'
    'Ab&O*SU6+tE6Rtf}m2j~W#Fz|DM}*<`nkB^UfaVV1b}1d6nQL^E9qpBLaf8(vJ{sA(T#hG`XjS@21Z*q@^|Pa7WH%Af8;sP(&uGN'
    'BjGS*G(mAr9u&!4J%ufL`1p$vE<;i0=Tiic$`Kwk9)oihV*mC$j4znp1IHUpuG{4uGH((YWST+ns78;vk!Q{781x_MVXxZg-'
    '<W{IVhs*xqo#Ux&WW|GQ!WBrM<s}nOZND}i0}YwUv=xc;rQ}7S1yN08P>n&1x4C5SZ=deOemZ$IU0diHW0%wvgVnFKC0R1uW=({9'
    'di)(bxKqiS%RmUR-JAjp55ZU@228`ncVCX+w~n5JV{lmwq5Kh8c_A}TbF0WSP$7ys!JgO`MUVLk3Tzc8*LK|-'
    '*71;gyU0WKy=uPIk{WA1*7Hz>Bm8f930`hvm{?!UJgp=>)?dhiaq<K4yk;yL+HTV<_b;8q_D<$+MR|A^j26d>;_}NekZVIc=rbGa'
    'gYfcn_wcHvuX{Z)d)w=a*-'
    'Y77%wdDByw0jiL4vzl=E>)HFkhwQGjpnaX((mgd{x4eUacFB&Q}eMpm*m+imx8b04XymdeSPfxg%98Y*3qI>X*p0<`VQupQB(eKy'
    'Cxw?(#`7w}&efJM5dhxUFQL)WLPRlFF&_t6B#_8w#$M=iod>lIY+%>pY46Fb(5AqRd_n{m>aaDX794QpmFD5k(eriTbhD(APV-Ko'
    'T-'
    '@)70iR@rgE@OT{u<lcSH1DBq@bCydfPup5e<b%~Tg8D?WEZ}Ga2P{$}XMCvKxGhjW|MWm7yGt2_MWZdMO)*DgZ#qz+`SFm2NVr<Z'
    'qI`MUiaN;j1iT3AsUQEUV^t%CMiD9+?`$F@D6-%8~eBf#-'
    'h1f9(T`?#o*jLp8MP9X7Q^?6s=@xMhE_)NkN1^^0p;E^G)2MPD>ObM8F(>s@$KgSo8}>N^YN%858|y(W+9^+D<m!Hy+{egC4k$4c'
    'GN4mD26H6mT)>S*{2$LRl+r$*EyjZzN+V^sO&yAOJzn0d`W+yCJLPJgFGiF59r*wDb+OZ*6#X5{52lS;DXO>2&UL|Eyvsi7%tSo@'
    ')j}%-'
    'ro;v#!=}#Tj!LDpFn3RYiCb&Q0f6HLT{ohug3we)c=!lsG@UtCj2cUvjamDwXawr#R7z5((UmM6rlV|S3%woAq?|f?PJeEVy=vnP'
    '3SKouCNEFb^opY)X|L>C(p(!`Z23%Y(M(p164Nn()z~rVt#2OVr_5LSljnD&CDW)vL71es<s;xD$W-'
    '~um`}xA3<cC=?*Wa>)KdH4{zawpk*z51kAFMT!C-'
    'MuSrH#RPL4XXNt3OeOxvDR1M2)r8s|)aA+MrRN64^q=G;3BT^;{&$@3SSTjlZ+x)rl9=~!p(ax#SR0&cmu7@NkLVr92ip<7;0S>q'
    'Y%;coF2edJ0&4jA;sqB$&%`(f$)H)S3bXUm#FBi9nV+58*kAe1(NKW70{lXLCL5eXHL3>dnj(&(y{UlqM_(AQN#FD8B&^gAs7Oh('
    '7?P}8+adMXb!vFV>GlCoFJ!<>Ewv9aLOB7_^<CL7OPtw#fVEGZfMbo~nM)Il*XtpCa;9QUO^-Gj7RSC+3u8*Az{-'
    '&O3qbpx1&!4b^)s{K4*gLYe3f>T>MQ#Y-'
    '(hdX{D&i3kzEy_ac*r#oPRpn4P6}<JSFb*r)i^LXdk%wbShoj=kQgeB%IUGi)?~zq$st?9AbTD)hIG<?OoD8@8jdwJxH_bL@!|@='
    'Rn#19m{k)^$zHz-'
    '|R6Aj@fNOC@s<1G71U<+o1f;7tPx{CfRSBCh9or+m)OA;VRvC~**(&5gP|USwC>!Pz>g#e{KjO$Jz|w@DMp>ryl%>WqZj;necLp6'
    '}3ijU+1p*fu?VF*-k0)H4s0tdXKbzWH4`c$fMf50?-%y>FEz<SiE5vN(i>jy-'
    'z)x4|VSQF5fdQ;*UALmJlqn5Xo&H)WUk$v)eB2#e=YZqxsGXawm{*--okF1*DDvp&gB@a{D0Pc<{p=g6Lh53-'
    'z*mT4(InZ@pCEPDs^e^MYk-ORiIy!U4X=#uM4ii9jj|laZd@qPoUp*M#8p0qxWMs@l6+}aO$DAiWZgJpEVUxDnu@cwt2*kxfqKYj'
    '4!t%%P+DF@YMlfcg<KwPnHL;ED~Xf)T3uUay|w+QhMzZFT<bW#hq?n`X`?7cIn@Q0gA~d%wA$j>&&P~;t3826?wqdtB@2frHd^&<'
    '&zf*}v;voB!G9{v8mq*2_WQ~Nnj1*I#Txl05D^)==3Q&NK)K>$eYwnaH$a%gulsl-'
    '1+1fJ>j|1`<kEC4fEIXoD|zf5$#9zlYU{b<`uQma*_)nGm1iGORUgU<=y?|fGXvIS234oi=(;&kn9{QAVbpH6B9WLqiL5GKC!<yE'
    'Ix2BgwSoPf+jwyV+9Sv28)V97KGM%QxNSC?00qSq3L1nmbG(9PB@n<wwVIaWQD_X6fs1EU)$)HK#I!I{4>H~2UkNjPLcTW8RH_Ru'
    'ykxCC-aYS{eRO(^is7e01RMisoaD;Qss*xY@UbP4^su6y6jmeQsmF9Ba_@pH*y?AP5|>|Jim&_&0izl1H$*-'
    '@TMZu<SAMA8?rMFD_``>e>AZbOYz#b7sA4<Tm*pDLV!DxQ2>BLM0tShx)nR-xDd`d}QGOAsAZ_O&!kb)jECcm?6Jd2i26G(wtt5v'
    '4?Yu+1>6^P;#|&!WS=Y=}bEUfK@I|v41Q#j)L6Fy+U@!?PeF7-QF*=ECfzKUIerr-Adw?hPksgsHFRYOsjezJYzOozr#m@3CP8hz'
    '5?x9?+WF{1S1#W70{^%8n{mH)F7T-C6C)Upv#`9KH`8M#K4l>(<VWd<)ASIYoLP5;4;c}E6sm9S>lM?5QM-'
    's!OYpkYMVH3W7ZL6|67_WoJxRq-lx206<tz*xF)euw1Rq|Owe68`pC&1eiL}|)KEKcGw&)`02Te4*<MYk;clMwMVfsg3MRu+>yn&'
    'j8n;65_B(9k1}ZGuYwWS|Q~exaPm2v^_`WY@aCjIvu&%{|!fMSr|pWE4_~r6b}}E7d5yWoDuu^C5>D;&-'
    'h4mtl|k_`+_xH4D(RQV3VO*<GR1X<F>7T(36bS4HRmv_-'
    'jsfMdTydOfEIBEl*_N5_>YP#QQzUIJ}B6Vo7dZvs(+L8+`vOUaf@itG9hy^;(aXe_xIy&884tT8*>8y;rI-NXLzpg-8{_68@z-'
    'Y7pfI@})~^iD?E$w|ID820kfUN$`FclY;p^HG04-'
    '|Y<#PKLu?*N?K=z%lD(xLh;OWO%eY=p7v&9~>X#2Pa2^!`|WGs5|KGX5E8c_vm1+chnyqz`U?>#8GzC-'
    '97H_=6ibwM<@M*qi*cgXhwHW(uP+Mrgm#IOXLAcfYQ9Vq=c)i1(4M~D94Cx<meftl(VHS676-'
    'iyW5&BZkamYa=FNgUz?5=NF9es>BH5m@m>@#tMf|}-'
    'kY22a<^wiTRGUbRS39K2U`>+X%Z(_e2h1x7!m)I8v)n;sjB3<vrRSht3dT^+Hw!0^?EA^T&dhr(VJjAfT~S5p80U(6c|;>&ShQvJ'
    '3htK5J_aJi5#Eoog5t<?(H9Xh!p5qRyf(z@$T`-'
    '{(kqkx8FV7h$#T=!EMboEG{&rpQbEVn+a*#c4Vuc<55e*=9(AE!>$VYD$dw5tv;%uisCXAc^|H`xt{`GX=tsiR?9gUBeUbU>zI_S'
    '&`U04O;u%9cilD>;&j0$b+=bMWksLnfMa%1)B@=M9JW4^N6S{<!=VN^psq?y%<P#hnrG^1uIo{?Q9Hn$;TC8PYu&e+*^=K@uj%lq'
    'S=X=1M7m|a&Y4-'
    ')t>8qMnSLy{>D^{VJy7M$gg>Q!=!%clcR>hIu9{V1<2u#0ZDNjvmO|}D`b|RK+^UViui9St*0S!@oGsCSLb;gacX&4qa)0&S0Uhf'
    '&l#iPas<VJrL`H@BS=G{n?S`bRuQY`2Q_~5?wt%P}LPt-'
    '^pj}n(Ig{FIIVg;!)DRSQQE*zS94+XEsIn|G#qctAqtS}Kx(t1Bh0%Wp-'
    '7YrU?UGQtw)J14y>2(?LbS+{QBZL(B!n1ZXdR0wtx7<>=Bq0h+Oby>)b&9kWf3RtVh^Z0E%c)7cDF%LzVdSAs@}rxan@WFVEojVI'
    'u*oiQ=ZG)rs4Sl3=$n%;q_J%9i!b*jE^=2XJQVmfP!5<#)?}5<{W)540qD5^#c8p3vvmtBcfNbO5CR00@c3rrs#T`J458?CslV+H'
    'Y`bM_0@c{0<KqeURvAwW^FdqnV61Eq5{QuY~w6dvFNRFdopb|x;uTbGm|dJ5pHTREI@kd?PIkV<|5U&)CPCVU&TX`8D4n@Z5=O7r'
    'o5+xN;|pfCH=K8T-'
    'P0&_0zU6Ah0>sVAw~?5ymTZ80=rBeh+uQR+y+{xYViPgSu7D$d5Cryca0&=ji8rG0P`Zxx1vI*%1v^QcAB$b{%~L9BQ*Pk|X_(2>'
    'fN#hl>J)y}@l~vyikNY*Cw2bBcslG;z`IUy?_I%hU0yl5ctdjgoq-3U2FA(Ml2JC50kHAAz2LTpdia5wyb^PKT#r;^qyjXlRBE3-'
    'eZBGJjm^R#&Z>FPmPr4=+$oqzphqMj&X*@Q9B8jK_jG!kE^BYu(!Qr0AP))6TcraA0)ia!XYS?v4&S*1M`rcOD?ZLw(yB=J@gYp+'
    'e?hJ5W$$@Qa=sVA`VN8gFKk`)3&8YmAkQFjj=ub(rcrcvUV+BaS>p?)h@gx5D$)xj4toM{t5DOL-'
    ';`GSzN0oUG*sD~A`ZmXeLgktv?=2#0OUeL3DsTPO8d$GSWzxlhdr{{jguATAjnwVR;#MA*>pmtb_PFRa3^qMyhmUNMb6MIltlEMJ'
    'wvb<U4i*1Oaq@NbUmcd%Rl^{7v<URT9{&zUqFEmX3N0;*+?dt&}-'
    'Rf@OCSXiUsh+LgcvaLEtbnj|!k}VZCupz@lfL5kcp*ts#kCppL2=NSQNf;Y_g$OT`jij!&z~)8?qzdu%bh@fdKoOU$)xm{27c(>G'
    'rWMsES*4_@s99O0G(xG$+{)yuTnxv>WgqW+_ntq{?yB7m|93OIKFY4CFW>F#n`F0D0c66ii4ozS?V=1L;}=ce&+_i!!EyI+x7XVr'
    '9cG95?*8t6-XHECW`ogwmW{gE$>CAAH`+Tn?)3+Q<9=^1I~tt~caM96-'
    'oC^%J%}o8et5ipaJ&!yV)^!JX>;f`1HP?y(%nDV>m3~&kB0k${_X(gu(y{F4~L_@VQ+6V%n$blgQLA+_vCnVoF8X<N5^{yqvO6aa'
    't)ows_?rfM@J_o$AkXS!C?1zx8H?s4u+$X{XFY+4@SFt{oT=S)*I}OdZR(_<m6zqpC23?_eb5M{XG!e9{lLJji%wC%^CMeMrT&GT'
    'X*Ms)mpR48pE$`)!vg=oXOuI>}vQKu&Qt_J}q~YSxVO@Z5s&g81j-'
    'GcF{amwUj>2e(e~d?R=H#_psXsR2UxQgOh{3lfg;e+uhwA=K0~lAV29J><#xugYI7M@Gw6*>1BiCd^aEVdj0+5d@t|s9#o7DY8;-'
    'BQg|MAhr1_Pmi3PE!{ejFY%e<)^mY%jgS>x|AN2Q*PxcQ+fZ%x#kS6aA4}0Ci{>kp~UT^<!)ZeQc!>sm?v8TKC=w^-'
    'CIrNbLveHoCJtS1^9+cL|!a?$}-ed>||D=1^-R}Vak2hH6O;#nE$d15y&qlhn5mDoF$e8G{3TpKMi=qA4|3-'
    'kewS{4Edz+%YB)OK#R;eyjCYUFMKA99TwQ)%Sz_9OpvN0_Ofc$nmPbb+5W>vRTC1j@BisL){ni?8mENpFXv?gZ#N_O=f^hG((WxW'
    'O~>$`%ba28e-'
    'Xlq|!Y1N8d(4_kGt_ve|xM9nxWI^2>6RI!~j^^~(tbdJZTA#WtY||cZxur$=Utm8Dle%>sSMV=1!g?fKZ%OtJh#Ll6dwd>YoPIiM'
    'UT37PxVr}|(^`r*$@Xh(ullJ8Ns|w^Gile`t5HUCt<t9QYoKkdDO+u?{|P_#tkxPf8?4t`S}slbnTo;+xlL1KMyjmv_ZQnRpJ<=-'
    '?UFJG$}v-__$&%@Vm*Ts$|OxLp7UDBlxT}$t+yqHVkSdkr7QBf^u6ZFXoeI`AIFP4q~xr-b*k?8R36>;vRpTr&^1N-'
    'jC0wJ%vvjr{U+oy5XiTnPmb~k!0*@j0|dSl(`4Fersz59VexnAqZg982>zxJwa0CG-'
    'i=>SdA&Zzz3yLR$I&DDWwL{HvA4!pPKq{6oJ^J~6jrLgy!UPZqn?Xt)%2I9Uj#Ims{EdLFT)>gL;184b#prd=G8yb{`PTh8JA3Y&'
    'H|5$Lamgl@Kc<~cTdi85-h{9G11AtsszSk@}bE713m(kHno{f4CZW;a772h*5`82=DAb{3TwXtQ|?CQBT`-'
    'gGF2}2Ut4|0Y9}`_ldh#*zp9#mce~aUwxVky(6f|Q%w?p$2wga}b~XJ?jctR;vgfA|qWK;@*xmt6ji8-'
    'EfOXKG0`PdvO`<=nc$=x`>{r&bhBmu{+O2Gm%{XC>;?bN)CACkD^$r@%pr3>WYS<m(kMu41v&}VOzQ+qPDshoR(nnC3)-'
    '#m}P{mG>vjnyqEiwX5+3|fh!k!s{s5frt9mqO-SB@0EbAyOs3muVO$X`&eyy6Feg=vNNL)BZrNrkk@U7)ck=(y=d4*TDz;<bOAv%'
    'n_51P68^4^q%=U_~iURV8r8uO#-'
    '1rYS`irVDB?eGP=h)m@LiE#LSYtXGXW)^6#5@O0UBTW10j*4liGboNKP6X^YXf<J+q<SOh?ppvAgX4ALHR}=0^=L7u$leDLJ`h#u'
    'KVHJ@qc<Je6l8wq5@o|khDcMq!q)pp({C!Ps5~pSZ^Z3f?-O+|<!*=sgHt>3Dx{F3emn-XzI4w3=rJt$<)!DPdZY1jyMy&B85z^x'
    'm97!I%3L}-'
    '(3T0M@rWkBbD66Q`D0_~(Nxo24uiE0?f+3ee=dDMt_!Y=a38(e6hd>GWwYCFQ2th0FLvAHoSrRI%uQ5t&NM<6f61Cc+Y<Ry$bwq2'
    '^1*(EyIgrD%q^t`}@2V-^L-vJgY>Vb6*~p}otf@?%!+E3Mp+^e(6h@UONP9t3VJjyjGwK(`vRp2*Ir$>$;~u@-'
    'c_YfPfH*+TFeUfN@#$2Am+0CAvC$OU80RViT^YvIrDZBe*%~jE+EeUeI>xNss!9jWxLg5d!=a<(#jq|)0WT}A1QKX7yQd?J-'
    'y$|Ru<K;~66UqE^^J|kNTgb02bZyWZ0=8^bpp{~Jd3X^fe^`mRe^&_$`|Kg_*zi6=!m0PC)PC})e-'
    ')+0Y*B|R%JjHAE?0{)m`mD4n)O>zMfKxpn{BQW6;gVr&9e;>68C$DxHKDqocGdOu2vmY(wkZo5>bd_WRm~*wym&8%@~#uVJ#@(rR'
    'teOa=_sELNXA{~1xc#M6Yu1nD9NVw5jXXh({LM}X)JGbkWmFN)Rm4e{Ah@c%jj(z?Dj`NOGe+6YOKKlq}%iQccbYnToK{EwnB*n|'
    '_=R`4riV%>m+q1-!Sj7>I=mZEJT-lo>d=>VBNuY&kVT70ieV4xhJuS&OkJx{3FbV{K*J`kbuTAra!x72n#c|yJ15`ojWZHfvct`e'
    '{O8c1KIaN>HSgIs9hiQ;ZGpDLYNTQtc_qwH594A!TrRv`>krNTmqR1vXyr0mV93Y(ckOz_}Jn^o<lxVEJDzf3o!7(?|9FadlL`}u'
    'V?i|hCjr-WtDKq%5`^O>*)Avt_mES4$OmY|COb`|*=1X7ta;ufOmDXL(DwPh>UyPY5KDO*l%W0|5anxfovzi5n8q%OoDITe>^nu('
    'V|USC{^p<(KUqC@(qCekG2i=i#gJf?FKH>-'
    'S%(~sx6Bp4>8Dry744c1AmTqbUr)onZ0mvMs0ZH%&qPqELx2vJL3>aH$&%fybGbKogW>EO1ewX4alPw`vpE9xst!a}T}BZFIe_P-'
    '#Vrd!smmiut0_7znyQfE=sTlhfK`4MYkPybL5{#KL4bu9#ICiaEFP+I{_F7I^nRIz!DdhJm;Q$0Y7N=aLAj7B`OF*+d@ahp`_K8#'
    '$>+@4#{=_rUYYdnu?`U!wz8}FmQw5<D)*Vn(+2kFcFkiOU#siwa#a4{l92-'
    'i*$j*@|KL>QsH?u`#ky_!~>MniJ+l_JQFjVd;|S=inGnbOa}@5Mc-<A%k2DU(9NB#6-'
    '~J)erSUyw8z$}#NHR1#ur=`VdpN!+)wR0*+7mM}5@YOhNZ@AYjJVL30U4a-'
    '7Y6d7RKtY$L}F5A7UW;KZ|V%}jFi|4`8Zz2vf3uf^RCKMLXspL^LN)=}giXwUzC3l)md>;?dsw&mw;7y|(c|X1eK$gHg-'
    '4nrBELO0^>|nqMwu3p?*#zHVjq7SbwXZerGQ}#G3*8|P2Ul)3nE=C|Eik9(d;;BLLWk(%4g8ZCWs*iPawno;wf4AUYEKlSa>LHUe'
    '!J0XPBB96BH*W|zX7}^n`@x*p-'
    'sG;>5d5G(!;{RB9;7@JRw}9@x3a%EXktIdZ}|X1S_v2qo5~Fb)&Gnf^1y+B!T$TYz{ObXClRvvZYg0v?A>&Adelq13Fp5Yp(T8wd'
    '(Cve**o+R}Jp0718jf<hs<;84TXyifq+bp4VB4y{oHoZzLX2RCsL#MC!Tz*{WQxdh`wVNmJt}(ALwcEmvCk(Fw*$g0LoIxAkohoQ'
    'T@|ME%z!hsRXF(Yt)KDlxf48Nul<7N-FhGT6Ip3Gxs%Fdhr~#%+=R*Eaj;g>;8^(S@ioRwQc7Hv52Koi?|Gm)<_;iaCva&!-'
    'Gs%@{`3k8OLbu>NC-4-'
    'Da27P!4X$0lWSI+$c7mKJ8GEd0FLNl8zYrlhS@misy24%SYj$U$^(4sr!RlT^s80u9c)ZG7YqV;twUQ+eS%SOjFe9hZ4cc^)+@>+'
    'c+37!=ZK&cTSES{ap?Hh#{p|6|G&>9uUEL!=w3az+{i8;T40?LMzB7rD0b&_h*;C1Agyz>w2+eU%}p@v}%l_F=shn=qu-mFP3#$Z'
    '2Gu?&y3^eSC7g-hEl*v}zbo47cs*VO>PY8qto39kkuX`+@bWLn1CpPsBYNoN?^&-'
    'xn+LsQmH#g3a=z<3mSNas&MVo+xV}b&L!Q@^O8`o9SxE9ck7c0#TW;S&#_A6i{f1#g>49u|CWn$IF}O#rfHbS9l~Y<37&??(*HP6'
    'AyC(B!=wPp14}$s-|m4P-+^AcQrdq<p-'
    '8NQ=p^;^15SB<I^fNRN#)ei#Q;sKB8Qqz&YM92kx~RcEdR3i>Y!U`W$;3K~@v~Q<ntvs8Sj0(tx5}2pW}4dV1UdcnAVC(4XW$y6o'
    'us8ciAsq9`pFB-hR3X6=TMKQzzrDzGUP{QHZ+PU{zGa9fYNnyLLD5w%dKipA8*X5a|rB+uuKZfDnVAzlKbk81MN6bx(tms-'
    '}k5wqDii7v5KM>$IjQ(KzPdyIwy|LHWFjYrV>%1co}eK+-'
    'npoxZ`kXDfGE!yd3C<+{k!Uf~1@B(<^_7>7Xy8g`?CLJRZRm?n;kcB5=+Y5tgNbptIU{gY(;Eb?T{!PU9;T%cpPL6iMx5kLS#tq7'
    'EQ85+UgdXG@2*CO0c-'
    '}BNDh^!44PvDOZwlf%1M0y~zO)sP4AgbxZa|TTpDdTbcn<wljSiG?MSYGI(D`bqBt?Q|&Bk!MHCiIuWi|p5qR;6~KAGoO+i9_y&F'
    '?$#FB|7|&VM!u)+Fi2^drrR-w178@bFYUsc5yasl`sIf6PgX14m)Hf-!(uMvB3u%Kco5zS>;+oYy${>kCtqx-wjlotr$&<o6}ZGI'
    '70m*JX;Xolt40fF9C(L>?Gv|9+X5zCBR#VFom|j{UI6IXNRbL`5~;R3<r`foP&|060&!447TxO$JurD^Nn2_)6Cx9$B-'
    '!eMVfbjwiMaY>2VsM`y(_PeDe%&KL6q93|lg;Jv|a=l1~PS-'
    '5@motq>|RHJ=#<&ZEYQxpHdnsznEh;X)Yis(d(jbxnb6C0;LHs`)t9VA@PI_y<y@U&@U5nQh++UfOfEB1;bCH7L@k2pOWohkq>Wg'
    'd1m<ff)%F*J95m91MMw^Xc&6OSn0S3+LJ=(Rp5VLGh1#vPuVzrQ3!s2iY8F~X!gQPiGhn9#q?rYm*OLt&c+@do&|MS8u;;KB)2ji'
    '=i5)s!`li=@%x_%Sq$(AyT$@j`4)9Rr#TO%_Qo#zT+g#avnAnM`i2fG)C*>yXm=KyPkg)gCD78(8Wd*DL&WJ$DSTqV}80yaVp%3y'
    'd=%=7^wE@gl9+w1<#^8CXA=PaUOEp}(Lqa)2OXC8&0|ek^;Hs~2`g{FnuHc%c{3p(kY{=&q+HLBZNG`HG6i)|02MsS$SVz>34XTh'
    'ZlJvs%<q`x)t7Q6j=KrDup_l(4$Bgba{>$_Gd;neCTu8~Oy0)C*goP}a6|oV3$w0E%?dHhiII9pVjLk8jbqf~4FzgA*=!qoPs83d'
    'C!D*61~@Cg@bT(T7>7jtB$cERZ8lY!vxAZJk<ymz5z@P?+v7j#m}o@3Dh4b7F-'
    '_WW^xYm_rW`L9`WU40LWdUNo9(%6+Oi>Ernfj@%q*ugK!UvBdqH?VIiiHu?BS(Z;kB=PtJdfr1t)w8<^Y4pFld__Iduuo>80qUCD'
    'al3q*WRzkbe;_edqSGyhYB)lcMUdD+krh00N5fF$4fu-UDHe<`FTH9JDY?Cs;wl+xwJg3o99#A|A^@q|d964zHIUdYc?2L6v6<`;'
    'ts>OVTI&ut*oaR%EPMh|1=W{eQ0`ExAAJ+7rGIwETt+<T`-'
    '%24)nJ06tjj8awtT*{aZp426p8Rkb;h1wEY<2NiVJp>IAhG5eLr6kdgx#o-'
    'nkmYdgOq*C*2ft*kp=3D4Sw9#A;?>{aWzu$J@IKM8S)l+;kOteP~g5Y#M)r;+A;LzNyC{Cq8_1W+Mu4P$?0f9*6|9p`x18XaB~bi'
    'vnoATEw7du>h3f|hSr3u)O&Sp8KSbjgFi=SlahnZMBV^J6-'
    '&pYp(!npdaNX36pI~?d#rWkd~~RX7rwkr?2J#fpBg*!HDhSDfXt@A6@gTBXsxu&YiOtMN23(K!N^~J7s}(}O~>tQ-LOueOT+z+UG'
    'r;<SWcwFgVm_74?}T+4XTEtSXla<0Rmlk9GC;kMX@Xf#bj$upTbojdZnZ1^Z!Q%B;EUE{0iHn$_VG~&KF$|sJr25Ju2ItEJ20t_`'
    '6o%*i@t@KNzomEZ3FTjN!@5Hcf(|>udV-gz%a^-'
    'C&s7{j357n4Z*#l@=_v!MpQ|m+xM_{_$~;@H{!zp03um_`ha6o;T|lUYx%=zc>%&w^)zt;WMKl@|a`e%}SfW62EemB(-'
    'RjqO#~;bYR!RefTJVyZ$=J6q|`Udx3@W?47+f5sq>y-'
    ';QDjv&?*@i*?;i;7oGeMewLg;7J#NJkF1%{~=V;Cfv1@qK4{k%=@whKCXdnYfC5uMltF|ar9-'
    'Wn>B0QboRCa*xFSNAG5q|&s>nt57#l1Y<}RJI$XXwa-Ki8D<!Jj27%S+`~as)wm}bsdhfm($+D$}2uY^+{P9tVEi)9y5t8lSEOAx'
    'l!tT96aQUN1(!Yt%|5`l06~?}h(>D>+9w!wtJ$O_nq%3@-AiPH44W5O6+aV0!xc>FYAOwl^Hnqw%GzD30WMB&d#Glsb>oEg~LUm-'
    'fiH6<@#FnZHi*4;z5zJkAi$vINUa0nJm&@{xBOM(SOpGgQIz!V#v*LU9h<b8&P64@~5#{c&xnkWS#Lb`suR;(~ax+XwXae%9C5q8'
    '%ve}QJ&g<HsunCK)0Uo(#S5l%`HX>+@Tvvul0hiK@IeYU*(cQ<eG*3KF>#<X(v)hcGkF=@U&?3*MT0zlZUE-~-'
    '9^d3zHKy1sVPB4_6*M)}{0s2(@i?lXTt(9Vdx?MXB~IBM(sgP1OfnhaG^f9LOnw^i)jGeqr>CYF+<svin!wkb6U)mjBhq6r<hQ69'
    'FY7aS>0WF#hH621>t_=(sdG%D2{T2whkaH&7DKtP=>4ekVyT0FvTar%f5vNbgI03rxSldKbVJ7+Rdb`6OfAw2W6M-'
    'F(iXfq`;U{xW?TAWhp42dp|<|hYI+*c%sdPgr_@cQy|*TJhMPVvsm&bM^8IycLh06Jf%&q;Dl&=q-'
    'R9A2(!6}FIZ%$mRLtb_?Wyk`dKd1+$*&ilrp~ap&U%F52^5SJpZ$3L`r>_h{`$A{`@?-)!uMy-'
    'e?EWx!aRB)#fGgFHl8)C=lr514=}(O`nz+sxL%<c@s{2ghgrNj({xx2(zGc*?PSAYnyGIZai#;@1~<hRn2$u~T#s9hExlr2ZiOtu'
    'SL=pqw{`Ny7KQC4Z&d+R_9l^+Z_W2~Jli_Y)+0Wo?Xq?8hEMrgNllOaSRd*~e^@N8ANK*rE$72_IVs4^i-'
    '0`V$wo{sE%ISa;<Mp!%+cj&+bA&=mdb`;!k<Ym<cD|ze!zz|PeFJ#7;m{KifR2k)_<RWS}wA-3fvjbuG<6jUUPbb!;!5f%cQryC-'
    '!t{v!_e2gWc}_@rKP<EkUZ0h`V7-'
    '<+f^z5<lTf6;$!q4^0fl)}JCHU#x0?d)(C?&~Qg#!V~U;{)4?3y5~k;7iDKP&C1(Gx9A=nHMjKIkzqSu!zDhzlm*<xfe)Ebnp_MF'
    'To%I5L`qx6WwT`>ZGoO&HmZ_~>-PuOcB6)4aAR-'
    '%xi*3fL?F1=jNot(@m*Qd3`h%(%`e*c<|?G$3diJfXeM#V<kw{!7QN)F?p|x+loD~mdL>=v-'
    '|?lU72aba0jVVcDUkqd)C(2WIyl52^{R6lK0WT8>{6?qX`_&yGfH&DdTa^{awC-Mu}O)k3$10h!2;gWbpuT9GP%RF7D*yR$N9~DI'
    'UYcNy5ErFvq=Fl&2Dqx^WfIy>VSbX!OozzV#sPtVUchoK@Q5{m#{@vTTd~u>wk~v+>+Xa5*)3a;|Og<&^@sKGpYF{U(*)8d6T|-'
    '@gMJ^|Kh)&zdJv>&_7<k`Qgp0S8x8K1w+D4h;ChqLgr)WknKP`;E1L@8io{(_^R_hefj>~`Hv0zp<W_`z<nM7R86uX_q*9-'
    'JiE1C!wA>vfB~3-9J!ig3j<p!KobHm0eLW6PC6rO11oN+->=?0|2aMXPXMO){rY?F+hIPkIcWek-=-'
    'mhETt~cSu7f{_&_*Mifmq{m@$$@_76v%@Gh?gk5b}ra`KNFB_+z~ynp%Q#reBmT9N(z^7V!MdG_kvFQIv=7W^OVt|b@e>vFkq25_'
    'D><jJo%mT5Dd<I4V;xSxiVy{cYVH4fOPn{B@`KrUeAll?OXQrD+wBB)VKmy}Cpz=<S``Ebp8)_Q(g=fNK^s6#P}S|<y)s*chT7LO'
    '8!$aUs4<2~L9c&F)^eg+ZnRLz&NwYsT$s~IVSikwQ_-'
    'G{m%JF7W5EH}bZxK3Taxk^eUiJ`w07zNiDWHSuf23+RRo1J0Kk|@v)5ayhKkkOd(L7lF_@~$@u(6hm$D07!kD!om2+Y~lDS3|pWy'
    'ok2R!FT!aG|~!Z&dGwwekOTR-UDy41jsMkggK2j@6S2)%Wue4sJ}0O2~~gooZqXz&Xxd)KA^SwU9S4Doyfp--'
    'kU$^UGvd%Ht`D->P!esSAPb~!)lh@W#b82<l?&3C`k5LW``4`GttoTNmG>I(^Q`trn2wv%Vj=2|1?H59t!x-*EbLUKg-qua{'
)


class Boundary(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.calls = []
        self.lease_nonce = None
        self.lease_version = None
        self.request_context = threading.local()
        self.mode = ''
        self.pause = threading.Event()
        self.release = threading.Event()
        self.limit = 10
        self.apps = [{'Name': APP, 'Organization': {'Slug': 'personal'}},
                     {'Name': 'other', 'Organization': {'Slug': 'personal'}}]
        self.machines = {DONOR: {'id': DONOR, 'name': 'cloudbench-warm', 'region': 'iad',
            'instance_id': 'original', 'state': 'started',
            'image_ref': {'digest': 'sha256:' + 'e' * 64},
            'config': {'image': 'registry.fly.io/bench@sha256:' + 'e' * 64,
                'env': {'TARGET': 'original', 'PRIVATE': 'never-print-this'},
                'mounts': [{'volume': VOL, 'path': '/data'}],
                'metadata': {'foreign_owner': 'foreign', 'rose_cloudbench_deps_' + hashlib.sha256(('a' * 64 + '\0' + 'b' * 64).encode()).hexdigest()[:32]: 'a' * 64 + ' ' + 'b' * 64 + ' 1794182400 vs_good ' + VOL + ' ' + DONOR + ' ' + APP},
                'guest': {'cpus': 8, 'cpu_kind': 'performance', 'memory_mb': 16384}}}}
        self.volumes = {VOL: {'id': VOL, 'name': 'donor', 'region': 'iad',
            'state': 'created', 'size_gb': 40, 'attached_machine_id': DONOR}}
        self.snapshots = [{'id': 'vs_good', 'status': 'created', 'size': 100,
                           'digest': 'f' * 64, 'created_at': '2026-11-09T00:00:00Z'}]
        test = self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass
            def do_GET(self): self.handle_request('GET')
            def do_POST(self): self.handle_request('POST')
            def do_DELETE(self): self.handle_request('DELETE')
            def handle_request(self, method):
                body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or b'null')
                test.request_context.nonce = self.headers.get('fly-machine-lease-nonce')
                test.calls.append((method, self.path, body))
                code, result = test.respond(method, self.path, body)
                raw = json.dumps(result).encode()
                self.send_response(code)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                try:
                    self.wfile.write(raw)
                except BrokenPipeError:
                    # The interruption test deliberately closes the client before ACK.
                    pass
        self.server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        base = 'http://127.0.0.1:' + str(self.server.server_port)
        binary = self.root / 'flyctl'
        binary.write_text('#!/usr/bin/env python3\nimport json,os,sys\nassert sys.argv[1:] == ["apps","list","--org","personal","--json"]\nprint(open(os.environ["FAKE_APPS"]).read())\n')
        binary.chmod(0o700)
        self.env = {**os.environ, 'PATH': str(self.root) + ':' + os.environ['PATH'],
                    'FLY_API_TOKEN': 'fake-token', 'FLY_FLAPS_BASE_URL': base,
                    'FLY_GRAPHQL_URL': base + '/graphql', 'CLOUDBENCH_CAPACITY_RESERVATION_ROOT': str(self.root / 'reservations'), 'FAKE_APPS': str(self.root / 'apps.json')}
        self.args = ['create', '--journal', str(self.root / 'journal'), '--owner-token', OWNER,
                     '--donor-machine-id', DONOR, '--donor-volume-id', VOL,
                     '--snapshot-id', 'vs_good', '--org', 'personal',
                     '--reserved-slots', '1', '--headroom', '1', '--extra-destroying-count', '1']

    def tearDown(self):
        self.release.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.tmp.cleanup()

    def respond(self, method, path, body):
        if path == '/graphql':
            return 200, {'data': {'organization': {'slug': 'personal', 'settings':
                {'machines_per_org_limit': self.limit}, 'billingStatus': 'current'}}}
        prefix = '/v1/apps/' + APP
        if path == '/v1/apps/other/machines?summary=true':
            return (503, {}) if self.mode == 'missing-app' else (200, [{'id': '11111111111111'}])
        suffix = path.removeprefix(prefix)
        nonce = getattr(self.request_context, 'nonce', None)
        if suffix == '/machines/22222222222222/lease':
            if '22222222222222' not in self.machines: return 404, {}
            if method == 'POST':
                if self.lease_nonce and nonce != self.lease_nonce: return 409, {}
                self.lease_nonce = 'lease-owned'
                self.lease_version = self.machines['22222222222222']['instance_id']
                return 201, {'data': {'nonce': self.lease_nonce, 'version': self.lease_version}}
            if method == 'DELETE':
                if nonce != self.lease_nonce: return 409, {}
                self.lease_nonce = None
                self.lease_version = None
                return 200, {}
        if suffix.startswith('/machines/22222222222222/metadata/'):
            if not self.lease_nonce or nonce != self.lease_nonce: return 409, {}
            key = suffix.rsplit('/', 1)[1]
            meta = self.machines['22222222222222']['config']['metadata']
            if method == 'POST': meta[key] = body['value']
            elif method == 'DELETE': meta.pop(key, None)
            return 200, {}
        if method == 'DELETE' and suffix == '/machines/22222222222222':
            if not self.lease_nonce or nonce != self.lease_nonce: return 409, {}
        if suffix == '/volumes/vol_owned/snapshots' and method == 'GET' and not hasattr(self, 'preparation_request'):
            return 200, getattr(self, 'own_snapshots', [])
        if hasattr(self, 'preparation_request'):
            handled = self.prepare_response(method, suffix, body)
            if handled is not None: return handled
        if suffix in ('/machines?summary=true', '/machines') and method == 'GET': return 200, list(self.machines.values())
        if suffix == '/volumes':
            if method == 'GET': return 200, list(self.volumes.values())
            if self.mode == 'volume-ambiguous': return 503, {'private': 'never-print-this'}
            row = {'id': 'vol_owned', 'name': body['name'], 'region': 'iad', 'state': 'created',
                   'size_gb': 40, 'encrypted': True, 'attached_machine_id': None, 'created_at': datetime.now(timezone.utc).isoformat()}
            if self.mode == 'protected-volume': row['id'] = VOL
            self.volumes[row['id']] = row
            if self.mode == 'lost-volume-ack':
                row['state'] = 'restoring'
                return 503, {}
            return 202, row
        if suffix == '/machines' and method == 'POST':
            # Durable volume receipt MUST already exist at this first Machine write.
            self.assert_volume_journal = any((self.root / ('journal/'+name)).exists() for name in
                                             ('volume.created.json', 'volume.reconciled.json'))
            if self.mode == 'machine-ambiguous': return 503, {'private': 'never-print-this'}
            if self.mode == 'quota': return 429, {'error': 'quota never-print-this'}
            if self.mode == 'interrupt-machine':
                self.pause.set()
                self.release.wait(5)
            row = {'id': '22222222222222', 'instance_id': 'newinstance', 'state': 'created',
                   'created_at': datetime.now(timezone.utc).isoformat(),
                   'image_ref': {'digest': 'sha256:' + 'e' * 64}, **copy.deepcopy(body)}
            if self.mode in ('normalized-machine', 'lost-machine-ack'):
                row['config'].pop('auto_destroy')
                if not row['config']['env']: row['config'].pop('env')
                row['config']['mounts'][0].update(name='cbs_' + OWNER[:26], size_gb=40, encrypted=True)
                row['state'] = 'stopped'
            self.machines[row['id']] = row
            self.volumes['vol_owned']['attached_machine_id'] = row['id']
            if self.mode == 'lost-machine-ack': return 503, {}
            return 201, row
        if suffix == '/volumes/' + VOL + '/snapshots': return 200, self.snapshots
        if suffix.startswith('/machines/'):
            identity = suffix.split('/')[2]
            if identity not in self.machines: return 404, {}
            if method == 'DELETE':
                del self.machines[identity]
                if self.mode == 'delete-lost-response':
                    self.volumes['vol_owned']['attached_machine_id'] = None
                    return 503, {}
                self.volumes['vol_owned']['attached_machine_id'] = None
                return 200, {}
            return 200, self.machines[identity]
        if suffix.startswith('/volumes/'):
            identity = suffix.split('/')[2]
            if identity not in self.volumes: return 404, {}
            if method == 'DELETE':
                if self.mode == 'volume-pending-destroy':
                    self.volumes[identity]['state'] = 'pending_destroy'
                    return 202, {}
                del self.volumes[identity]
                return 200, {}
            return 200, self.volumes[identity]
        return 404, {}

    def run_cli(self, args=None):
        (self.root / 'apps.json').write_text(json.dumps(self.apps))
        result = subprocess.run([sys.executable, str(CLI), *(args or self.args)],
                                env=self.env, capture_output=True, text=True, timeout=15)
        self.assertNotIn('never-print-this', result.stdout + result.stderr)
        return result

    def writes(self):
        return [x for x in self.calls if x[0] != 'GET' and x[1] != '/graphql' and not x[1].endswith('/lease')]

    def test_create_parked_exact_owned_and_reuse_without_allocation(self):
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        value = json.loads(result.stdout)
        self.assertEqual(value['machine_id'], '22222222222222')
        self.assertTrue(self.assert_volume_journal)
        self.assertEqual(len(self.writes()), 2)
        body = self.writes()[-1][2]
        self.assertTrue(body['skip_launch'])
        self.assertEqual(body['name'], 'cloudbench-source-' + OWNER)
        self.assertEqual(body['config']['metadata']['cloudbench_source_owner'], OWNER)
        self.assertEqual(body['config']['env'], self.machines[DONOR]['config']['env'])
        self.assertEqual(body['config']['guest'], {'cpu_kind': 'shared', 'cpus': 1, 'memory_mb': 2048})
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)

    def test_capacity_all_apps_reservations_and_headroom(self):
        self.limit = 5  # 2 native + 1 reservation + 1 destroying + 1 headroom leaves zero.
        result = self.run_cli()
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(self.writes())
        self.assertIn('/v1/apps/other/machines?summary=true', [c[1] for c in self.calls])

    def test_native_machine_omitted_defaults_and_volume_metadata(self):
        self.machines[DONOR]['config']['env'] = {}
        self.mode = 'normalized-machine'
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), 2)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)

    def make_ambiguous_machine(self):
        self.machines[DONOR]['config']['env'] = {}
        self.mode = 'lost-machine-ack'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.mode = ''
        journal = self.root/'journal'
        self.assertTrue((journal/'machine.pending.json').exists())
        self.assertFalse((journal/'machine.created.json').exists())
        self.assertEqual(len(self.writes()), 2)
        return journal

    def test_lost_machine_ack_explicit_get_only_receipt_then_prepare_authority(self):
        journal = self.make_ambiguous_machine()
        original = {p.name:p.read_bytes() for p in journal.glob('*.json')}
        before = len(self.calls)
        result = self.run_cli(['reconcile-machine', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(all(call[0] == 'GET' for call in self.calls[before:]))
        receipt = json.loads(result.stdout)
        self.assertEqual(receipt['authority_kind'], 'reconciled-ambiguous-machine-create')
        self.assertFalse((journal/'machine.created.json').exists())
        for name, raw in original.items(): self.assertEqual((journal/name).read_bytes(), raw)
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 2)
        helper = runpy.run_path(str(CLI))
        authority = helper['verify_created_source'](journal/'result.json')
        self.assertEqual(authority['machine_authority'], 'reconciled-ambiguous-machine-create')
        native = self.machines['22222222222222']['config']
        self.assertEqual(authority['machine']['config'], native)
        self.assertEqual(json.loads((journal/'result.json').read_text())['config_sha256'],
                         hashlib.sha256(json.dumps(native, sort_keys=True, separators=(',', ':')).encode()).hexdigest())

    def test_reconcile_machine_real_preparer_and_authenticated_retirement(self):
        self.machine_reconcile_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_failed_prestart_recovery_fresh_prepare_and_authenticated_retirement(self):
        self.recover_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_historical_failure_recovery_fresh_ssh_prepare_and_retirement(self):
        self.fresh_prepare_ssh = True
        self.recover_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_reconciled_machine_stdout_never_discloses_inventory_environment(self):
        self.make_ambiguous_machine()
        self.machines['33333333333333'] = dict(id='33333333333333', name='foreign',
            config={'env': {'PRIVATE': 'never-print-this'}})
        result=self.run_cli(['reconcile-machine',*self.args[1:]])
        self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(json.loads(result.stdout)['id'],'22222222222222')

    def test_reconcile_machine_forged_native_identity_config_defaults_and_mount_refuse(self):
        journal = self.make_ambiguous_machine()
        original = copy.deepcopy(self.machines['22222222222222'])
        volume = copy.deepcopy(self.volumes['vol_owned'])
        mutations = ['owner','nonce','intent','protocol','image','digest','region','instance','active',
                     'init','guest','guest-type','restart','extra-config','extra-mount','mount-extra','mount-name',
                     'mount-size','mount-encryption','default-true','default-zero','env-null','env-change',
                     'protected','wrong-time','attachment','duplicates']
        for mutation in mutations:
            with self.subTest(mutation=mutation):
                self.machines = {DONOR:self.machines[DONOR], '22222222222222':copy.deepcopy(original)}
                self.volumes['vol_owned'] = copy.deepcopy(volume)
                row=self.machines['22222222222222'];config=row['config'];mount=config['mounts'][0]
                if mutation in ('owner','nonce','intent','protocol'):
                    key={'owner':'owner','nonce':'create_nonce','intent':'create_intent','protocol':'protocol'}[mutation]
                    config['metadata']['cloudbench_source_'+key]='forged'
                elif mutation=='image':config['image']='registry.fly.io/bench@sha256:'+'f'*64
                elif mutation=='digest':row['image_ref']['digest']='sha256:'+'f'*64
                elif mutation=='region':row['region']='ams'
                elif mutation=='instance':row['instance_id']=''
                elif mutation=='active':row['state']='started'
                elif mutation=='init':config['init']={'cmd':['echo','unsafe']}
                elif mutation=='guest':config['guest']['cpus']=2
                elif mutation=='guest-type':config['guest']['cpus']=True
                elif mutation=='restart':config['restart']={'policy':'always'}
                elif mutation=='extra-config':config['services']=[]
                elif mutation=='extra-mount':config['mounts'].append(dict(mount))
                elif mutation=='mount-extra':mount['unrecognized']=False
                elif mutation=='mount-name':mount['name']='foreign'
                elif mutation=='mount-size':mount['size_gb']=True
                elif mutation=='mount-encryption':mount['encrypted']=False
                elif mutation=='default-true':config['auto_destroy']=True
                elif mutation=='default-zero':config['auto_destroy']=0
                elif mutation=='env-null':config['env']=None
                elif mutation=='env-change':config['env']={'NEW':'foreign'}
                elif mutation=='protected':row['id']=DONOR
                elif mutation=='wrong-time':row['created_at']='2026-01-01T00:00:00Z'
                elif mutation=='attachment':self.volumes['vol_owned']['attached_machine_id']=DONOR
                elif mutation=='duplicates':self.machines['33333333333333']=dict(row,id='33333333333333')
                before=len(self.writes())
                self.assertNotEqual(self.run_cli(['reconcile-machine', *self.args[1:]]).returncode,0)
                self.assertEqual(len(self.writes()),before)
                self.assertFalse((journal/'machine.reconciled.json').exists())

    def test_reconcile_machine_original_inventory_failure_and_receipt_tamper_refuse(self):
        journal=self.make_ambiguous_machine()
        for name in ('machine.pending.json','machine.failed.json'):
            path=journal/name;original=path.read_bytes();value=json.loads(original)
            if 'failed' in name:value['outcome']='native-rejected';value['native_http_status']=429
            else:value['precreate']['sha256']='0'*64
            path.write_text(json.dumps(value))
            self.assertNotEqual(self.run_cli(['reconcile-machine',*self.args[1:]]).returncode,0)
            path.write_bytes(original)
        self.assertEqual(self.run_cli(['reconcile-machine',*self.args[1:]]).returncode,0)
        path=journal/'machine.reconciled.json';value=json.loads(path.read_bytes())
        value['response']['config']['metadata']['cloudbench_source_owner']='f'*32
        value['response_sha256']=runpy.run_path(str(CLI))['sha'](value['response'])
        path.write_text(json.dumps(value))
        before=len(self.writes());self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(len(self.writes()),before)

    def test_successful_native_response_is_saved_before_semantic_refusal(self):
        actual=self.respond
        def wrong(method,path,body):
            status,row=actual(method,path,body)
            if method=='POST' and path.endswith('/machines') and status==201:
                row['config']['services']=[]
            return status,row
        self.respond=wrong
        self.assertNotEqual(self.run_cli().returncode,0)
        journal=self.root/'journal'
        raw=json.loads((journal/'machine.response.raw.json').read_bytes())
        self.assertEqual(raw['id'],'22222222222222')
        self.assertTrue((journal/'machine.response.json').exists())
        self.assertFalse((journal/'machine.created.json').exists())
        self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(len(self.writes()),2)

    def test_recovered_retirement_checks_original_custody_before_successor_verifier(self):
        """Creator trust boundary; recovery and successful-prepare verifiers are explicit doubles."""
        self.assertEqual(self.run_cli().returncode, 0)
        creator=runpy.run_path(str(CLI));journal=self.root/'journal'
        intent=creator['read'](journal/'intent.json')
        original=creator['verify_created_source'](journal/'result.json')
        recovered=copy.deepcopy(original)
        recovered['original_creator']=dict(path=str(journal/'result.json'),sha256=creator['raw_sha'](journal/'result.json'))
        recovered['machine'].update(state='stopped',instance_id='recovered')
        recovered['machine']['config']['image']='registry.fly.io/navi-whisper-lux-bench@sha256:'+'d'*64
        recovered['volume']=copy.deepcopy(self.volumes['vol_owned'])
        recovery_path=self.root/'recovered-bootstrap.json'
        creator['save'](recovery_path,dict(schema='cloudbench-recovered-bootstrap-v1',qualified=False,credit_granted=False))
        request_path=self.root/'new-request.json';result_path=self.root/'new-result.json';manifest_path=self.root/'new-manifest.json'
        image='registry.fly.io/navi-whisper-lux-bench@sha256:'+'f'*64
        request=dict(ownership=dict(path=str(recovery_path),sha256=creator['raw_sha'](recovery_path)),
                     image_ref=image,source_ref='b'*40,node_fingerprint='a'*64,python_fingerprint='b'*64)
        creator['save'](request_path,request)
        after=copy.deepcopy(recovered['machine']);after['instance_id']='new-success';after['config']['image']=image
        after_path=self.root/'new-after.json';creator['save'](after_path,after)
        creator['save'](result_path,dict(after=dict(path=str(after_path),sha256=creator['raw_sha'](after_path))))
        creator['save'](manifest_path,{})
        verified=Mock(return_value=dict(owner_token=OWNER,machine_id='22222222222222',volume_id='vol_owned',instance_id='new-success'))
        helper=dict(resolve_bootstrap_ownership=lambda path:copy.deepcopy(recovered),verify_prepared_source=verified,
                    described=lambda descriptor:creator['read'](Path(descriptor['path'])))
        actual=runpy.run_path
        def load(path,*args,**kwargs):
            if Path(path)==ROOT/'scripts/cloudbench-prepare-source.py':return helper
            return actual(path,*args,**kwargs)
        args=SimpleNamespace(prepared_request=request_path,prepared_result=result_path,prepared_manifest=manifest_path)
        baseline=copy.deepcopy(recovered)
        mutations=['original-path','original-sha','journal','intent','machine','volume','mount','owner','nonce','claim','shape','state','version']
        before=len(self.writes())
        with patch.object(runpy,'run_path',side_effect=load):
            for mutation in mutations:
                recovered.clear();recovered.update(copy.deepcopy(baseline))
                if mutation=='original-path':recovered['original_creator']['path']=str(self.root/'foreign-result.json')
                elif mutation=='original-sha':recovered['original_creator']['sha256']='0'*64
                elif mutation=='journal':recovered['journal']=str(self.root/'foreign-journal')
                elif mutation=='intent':recovered['intent']['nonce']='0'*32
                elif mutation=='machine':recovered['machine']['id']=DONOR
                elif mutation=='volume':recovered['volume']['id']=VOL
                elif mutation=='mount':recovered['machine']['config']['mounts'][0]['volume']=VOL
                elif mutation=='owner':recovered['machine']['config']['metadata']['cloudbench_source_owner']='f'*32
                elif mutation=='nonce':recovered['machine']['config']['metadata']['cloudbench_source_create_nonce']='f'*32
                elif mutation=='claim':recovered['machine']['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='open'
                elif mutation=='shape':recovered['machine']['config']['guest']['cpus']=4
                elif mutation=='state':recovered['machine']['state']='started'
                elif mutation=='version':recovered['machine']['instance_id']=''
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                    creator['retirement_successor'](args,journal,intent)
                verified.assert_not_called()
                self.assertFalse((journal/'retirement.admission.json').exists())
            recovered.clear();recovered.update(copy.deepcopy(baseline))
            self.assertEqual(creator['retirement_successor'](args,journal,intent),after)
            verified.assert_called_once()
        self.assertEqual(len(self.writes()),before)

    def test_ready_native_get_shape_is_authoritative_and_sealed(self):
        self.machines[DONOR]['config']['env'] = {}
        actual=self.respond
        def normalized_get(method,path,body):
            status,row=actual(method,path,body)
            if method=='GET' and path.endswith('/machines/22222222222222'):
                row=copy.deepcopy(row);row['config'].pop('auto_destroy',None);row['config'].pop('env',None)
                row['config']['mounts'][0].update(name='cbs_'+OWNER[:26],size_gb=40,encrypted=True)
            return status,row
        self.respond=normalized_get
        result=self.run_cli();self.assertEqual(result.returncode,0,result.stderr)
        helper=runpy.run_path(str(CLI));journal=self.root/'journal'
        authority=helper['verify_created_source'](journal/'result.json')
        self.assertNotIn('env',authority['machine']['config'])
        self.assertIn('name',authority['machine']['config']['mounts'][0])
        ready=journal/'machine.ready.json';changed=json.loads(ready.read_bytes())
        changed['response']['config']['metadata']['cloudbench_source_owner']='forged';ready.write_text(json.dumps(changed))
        before=len(self.writes());self.assertNotEqual(self.run_cli().returncode,0)
        self.assertEqual(before,len(self.writes()))

    def test_incomplete_scope_or_snapshot_refuses_before_write(self):
        for mode in ['missing-app', 'snapshot']:
            with self.subTest(mode=mode):
                self.mode = mode
                if mode == 'snapshot': self.snapshots[0]['status'] = 'running'
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertFalse(self.writes())

    def test_ambiguous_create_never_retries_or_adopts(self):
        for mode in ['volume-ambiguous', 'machine-ambiguous']:
            with self.subTest(mode=mode):
                self.mode = mode
                self.args[2] = str(self.root / mode)
                first = self.run_cli()
                self.assertNotEqual(first.returncode, 0)
                count = len(self.writes())
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertEqual(len(self.writes()), count)

    def test_foreign_name_or_owner_cannot_be_reused(self):
        self.machines['832717a71940d8'] = {'id': '832717a71940d8', 'name': 'cloudbench-source-' + OWNER,
            'config': {'metadata': {'cloudbench_source_owner': 'a67a0f74e9f12f9b8ab68f7f2544975c'}}}
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_tamper_intent_receipt_and_native_owner_fail_closed(self):
        self.assertEqual(self.run_cli().returncode, 0)
        baseline = len(self.writes())
        machine = self.machines['22222222222222']
        machine['config']['metadata']['cloudbench_source_owner'] = 'b' * 32
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), baseline)
        machine['config']['metadata']['cloudbench_source_owner'] = OWNER
        receipt = self.root / 'journal/machine.created.json'
        original = receipt.read_bytes()
        changed = json.loads(original)
        changed['id'] = DONOR
        receipt.write_text(json.dumps(changed))
        self.assertNotEqual(self.run_cli().returncode, 0)
        receipt.write_bytes(original)
        self.args[-1] = '2'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), baseline)

    def test_cleanup_exact_receipts_only_and_protects_donors(self):
        self.assertEqual(self.run_cli().returncode, 0)
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.machines), {DONOR})
        self.assertEqual(set(self.volumes), {VOL})
        self.assertTrue(all(DONOR not in x[1] and VOL not in x[1] for x in self.writes()))

    def test_participating_reader_is_fenced_during_native_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        actual = self.respond
        attempts = []
        def after_observation(method, path, body):
            answer = actual(method, path, body)
            if method == 'GET' and path == '/v1/apps/navi-whisper-lux-bench/machines':
                status, _ = actual('POST', '/v1/apps/navi-whisper-lux-bench/machines/22222222222222/lease',
                                   {'ttl': 180, 'description': 'cloudbench-source-lease-v1'})
                attempts.append(status)
                if status == 201:
                    self.machines['33333333333333'] = {'id': '33333333333333', 'config': {
                        'metadata': {'cloudbench_clone_source': '22222222222222'}, 'mounts': []}}
            return answer
        self.respond = after_observation
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(attempts, [409], 'reader crossed the native retirement lease')
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('33333333333333', self.machines)
        self.assertEqual(self.respond('POST', '/v1/apps/' + APP + '/machines/22222222222222/lease', {})[0], 404)

    def test_expired_consumer_lease_with_durable_claim_refuses_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['22222222222222']['config']['metadata']['cloudbench_source_consumer_' + 'c' * 32] = 'durable-orphan'
        count = len([c for c in self.calls if c[0] == 'DELETE' and '/lease' not in c[1]])
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(count, len([c for c in self.calls if c[0] == 'DELETE' and '/lease' not in c[1]]))
        self.assertIn('22222222222222', self.machines)

    def test_readonly_bootstrap_verifier_and_tamper(self):
        self.assertEqual(self.run_cli().returncode, 0)
        creator = runpy.run_path(str(CLI))
        path = self.root / 'journal/result.json'
        calls = len(self.calls)
        result = creator['verify_created_source'](path)
        self.assertEqual(result['machine']['id'], '22222222222222')
        self.assertEqual(result['donor']['dependency_proof']['node_fingerprint'], 'a' * 64)
        self.assertEqual(len(self.calls), calls)
        pending = self.root / 'journal/machine.pending.json'
        value = json.loads(pending.read_text())
        value['request']['config']['env']['PRIVATE'] = 'tampered'
        pending.write_text(json.dumps(value))
        with self.assertRaises(ValueError): creator['verify_created_source'](path)

    def test_observed_normal_fleet_reservations_are_counted_never_pruned(self):
        directory = self.root / 'reservations/reservations'
        directory.mkdir(parents=True)
        receipt = directory / 'foreign-primary'
        receipt.write_text('version=1\napp=' + APP + '\nhost=another-host\npid=999999\npid_start=unknown\nrun_id=foreign\ntoken=foreign-primary\nmachine_slots=100\nshared_units=0\nkind=primary\n')
        self.limit = 100
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())
        self.assertTrue(receipt.exists())
        receipt.write_text('not a valid reservation')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_environment_change_between_volume_and_machine_refuses(self):
        original = self.respond
        def changed(method, path, body):
            result = original(method, path, body)
            if method == 'POST' and path.endswith('/volumes'):
                self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
            return result
        self.respond = changed
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 1)
        self.assertEqual(self.writes()[0][1], '/v1/apps/' + APP + '/volumes')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), 1)

    def test_acknowledged_unattached_volume_cleanup_after_pre_machine_failure(self):
        original = self.respond
        def changed(method, path, body):
            result = original(method, path, body)
            if method == 'POST' and path.endswith('/volumes'):
                self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
            return result
        self.respond = changed
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse((self.root / 'journal/machine.pending.json').exists())
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.volumes), {VOL})
        self.assertEqual(set(self.machines), {DONOR})

    def test_donor_attestation_and_wrong_snapshot_fail_before_write(self):
        metadata = self.machines[DONOR]['config']['metadata']
        metadata.clear()
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.writes())

    def test_quota_native_rejection_is_not_create_retry_authority(self):
        self.mode = 'quota'
        self.assertNotEqual(self.run_cli().returncode, 0)
        count = len(self.writes())
        self.mode = ''
        failure = json.loads((self.root / 'journal/machine.failed.json').read_text())
        self.assertEqual(failure['native_http_status'], 429)
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def test_protected_volume_response_cannot_grant_cleanup_rights(self):
        self.mode = 'protected-volume'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse((self.root / 'journal/volume.created.json').exists())
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.assertFalse(any(c[0] == 'DELETE' for c in self.calls))

    def test_interruption_between_machine_post_and_ack_retains_no_retry(self):
        self.mode = 'interrupt-machine'
        (self.root / 'apps.json').write_text(json.dumps(self.apps))
        process = subprocess.Popen([sys.executable, str(CLI), *self.args], env=self.env,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertTrue(self.pause.wait(5), 'Machine POST not observed')
            process.send_signal(signal.SIGTERM)
            stdout, stderr = process.communicate(timeout=5)
            self.assertNotEqual(process.returncode, 0)
            self.assertTrue((self.root / 'journal/volume.created.json').exists())
            self.assertFalse((self.root / 'journal/machine.created.json').exists())
            count = len(self.writes())
            self.assertNotEqual(self.run_cli().returncode, 0)
            self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
            self.assertEqual(len(self.writes()), count)
        finally:
            self.release.set()
            if process.poll() is None:
                process.terminate()
                process.communicate(timeout=5)

    def test_interrupted_delete_resumes_by_positive_absence_without_repeating(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.mode = 'delete-lost-response'
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.mode = ''
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        machine_deletes = [c for c in self.calls if c[0] == 'DELETE' and c[1].endswith('/machines/22222222222222')]
        self.assertEqual(len(machine_deletes), 1)
        self.assertEqual(set(self.machines), {DONOR})

    def test_native_pending_destroy_volume_confirms_exact_retirement(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.mode = 'volume-pending-destroy'
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        receipt = json.loads((self.root / 'journal/volume.deleted.json').read_text())
        self.assertEqual(receipt['id'], 'vol_owned')
        self.assertEqual(receipt['native_state'], 'pending_destroy')
        self.assertEqual(self.volumes['vol_owned']['state'], 'pending_destroy')
        self.assertEqual(set(self.machines), {DONOR})

    def test_foreign_or_symlink_journal_never_admitted(self):
        target = self.root / 'actual'
        target.mkdir(mode=0o700)
        (self.root / 'journal').symlink_to(target, target_is_directory=True)
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertFalse(self.calls)

    def test_source_consumer_blocks_cleanup_without_mutation(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['33333333333333'] = {'id': '33333333333333', 'config': {
            'metadata': {'cloudbench_source_owner': OWNER}, 'mounts': []}}
        count = len(self.writes())
        result = self.run_cli(['cleanup', *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def test_changed_prepared_image_needs_authenticated_successor_receipts(self):
        self.assertEqual(self.run_cli().returncode, 0)
        self.machines['22222222222222']['instance_id'] = 'prepared'
        self.machines['22222222222222']['config']['image'] = 'registry.fly.io/bench@sha256:' + 'd' * 64
        count = len(self.writes())
        self.assertNotEqual(self.run_cli(['cleanup', *self.args[1:]]).returncode, 0)
        self.assertEqual(len(self.writes()), count)

    def test_absolute_response_deadline_preserves_class_phase_without_status_invention(self):
        creator = runpy.run_path(str(CLI))
        class Response:
            status = 202
            def __enter__(self): return self
            def __exit__(self, *_): return False
            def read(self, *_): raise creator['DEADLINES']['Deadline']('controller action deadline')
        class Opener:
            def open(self, *_args, **_kwargs): return Response()
        native = object.__new__(creator['Native'])
        native.auth, native.opener = 'Bearer fake', Opener()
        with self.assertRaises(creator['Refusal']) as caught:
            native.request('POST', 'https://example.invalid/volumes', {'name': 'local-only'})
        self.assertEqual(caught.exception.native_status, 202)
        self.assertEqual(caught.exception.diagnostic['exception_class'], 'Deadline')
        self.assertEqual(caught.exception.diagnostic['response_phase'], 'body')
        self.assertEqual(caught.exception.diagnostic['reason'], 'absolute-response-deadline')
        self.assertFalse(self.calls)

    def make_ambiguous_volume(self):
        self.mode = 'lost-volume-ack'
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.mode = ''
        journal = self.root/'journal'
        self.assertTrue((journal/'volume.pending.json').exists())
        self.assertFalse((journal/'volume.created.json').exists())
        self.assertFalse((journal/'machine.pending.json').exists())
        return journal

    def test_owned_snapshot_fork_survives_unrelated_donor_image_activation(self):
        journal = self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        original = json.loads((journal/'intent.json').read_text())['donor']
        self.volumes['vol_owned']['state'] = 'created'
        self.machines[DONOR]['instance_id'] = 'different-image-activation'
        self.machines[DONOR]['config']['image'] = 'registry.fly.io/bench@sha256:' + '7'*64
        self.machines[DONOR]['image_ref']['digest'] = 'sha256:' + '7'*64
        before = len(self.writes())
        result = self.run_cli()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), before + 1)
        self.assertEqual(self.writes()[-1][1], '/v1/apps/' + APP + '/machines')
        self.assertEqual(self.writes()[-1][2]['config']['image'], original['image'])
        self.assertEqual(self.writes()[-1][2]['config']['mounts'], [{'volume':'vol_owned','path':'/data'}])
        self.assertFalse((journal/'volume.created.json').exists())
        self.assertTrue((journal/'volume.failed.json').exists())

    def test_owned_fork_still_refuses_snapshot_environment_mount_or_volume_tampering(self):
        self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.volumes['vol_owned']['state'] = 'created'
        original_machine = copy.deepcopy(self.machines[DONOR])
        original_snapshot = copy.deepcopy(self.snapshots)
        original_volume = copy.deepcopy(self.volumes['vol_owned'])
        before = len(self.writes())
        for kind in ('snapshot', 'environment', 'mount', 'owned-encryption'):
            with self.subTest(kind=kind):
                self.machines[DONOR] = copy.deepcopy(original_machine)
                self.snapshots = copy.deepcopy(original_snapshot)
                self.volumes['vol_owned'] = copy.deepcopy(original_volume)
                if kind == 'snapshot': self.snapshots[0]['digest'] = '0'*64
                elif kind == 'environment': self.machines[DONOR]['config']['env']['TARGET'] = 'changed'
                elif kind == 'mount': self.machines[DONOR]['config']['mounts'][0]['volume'] = 'vol_foreign'
                else: self.volumes['vol_owned']['encrypted'] = False
                self.assertNotEqual(self.run_cli().returncode, 0)
                self.assertEqual(len(self.writes()), before)

    def test_lost_ack_reconcile_is_get_only_preserves_receipts_and_waits_for_created(self):
        journal = self.make_ambiguous_volume()
        original = {name: (journal/name).read_bytes() for name in ('intent.json', 'volume.pending.json', 'volume.failed.json')}
        writes = len(self.writes())
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'volume.created.json').exists())
        receipt = json.loads((journal/'volume.reconciled.json').read_text())
        self.assertEqual(receipt['authority_kind'], 'reconciled-ambiguous-volume-create')
        self.assertEqual(receipt['id'], 'vol_owned')
        self.assertFalse(receipt['snapshot_lineage_verified'])
        self.assertEqual(receipt['snapshot_provenance'], 'original-writeahead-request')
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.volumes['vol_owned']['state'] = 'created'
        self.assertEqual(self.run_cli().returncode, 0)
        self.assertEqual(len([c for c in self.writes() if c[1].endswith('/volumes')]), 1)
        for name, raw in original.items(): self.assertEqual((journal/name).read_bytes(), raw)
        creator = runpy.run_path(str(CLI))
        authority = creator['verify_created_source'](journal/'result.json')
        self.assertEqual(authority['volume_authority'], 'reconciled-ambiguous-volume-create')
        self.assertEqual(authority['volume']['id'], 'vol_owned')

    def test_reconciled_real_creator_preparer_verification_chain(self):
        self.reconcile_before_prepare = True
        self.test_real_creator_preparer_and_authenticated_successor_retirement()

    def test_reconcile_rejects_wrong_time_duplicates_protected_and_native_rejection(self):
        journal = self.make_ambiguous_volume()
        row = self.volumes['vol_owned']; original = dict(row)
        writes = len(self.writes())
        for mutation in ('wrong-time', 'duplicates', 'protected', 'attached', '4xx'):
            with self.subTest(mutation=mutation):
                self.volumes['vol_owned'] = dict(original)
                row = self.volumes['vol_owned']
                failed_path = journal/'volume.failed.json'; failed_raw = failed_path.read_bytes()
                if mutation == 'wrong-time': row['created_at'] = '2020-01-01T00:00:00Z'
                if mutation == 'duplicates': self.volumes['vol_other'] = dict(row, id='vol_other')
                if mutation == 'protected': row['id'] = VOL
                if mutation == 'attached': row['attached_machine_id'] = DONOR
                if mutation == '4xx':
                    failed = json.loads(failed_raw); failed.update(outcome='native-rejected', native_http_status=429)
                    failed_path.write_text(json.dumps(failed)); failed_path.chmod(0o600)
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())
                self.assertEqual(len(self.writes()), writes)
                self.volumes.pop('vol_other', None); failed_path.write_bytes(failed_raw)

    def test_reconcile_rejects_missing_false_or_wrongtype_encryption(self):
        journal = self.make_ambiguous_volume()
        row = self.volumes['vol_owned']
        for value in (False, None, 'true', 1):
            with self.subTest(encrypted=value):
                if value is None: row.pop('encrypted', None)
                else: row['encrypted'] = value
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())

    def assert_reconciled_live_encryption_change_refuses(self, action):
        journal = self.make_ambiguous_volume()
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.volumes['vol_owned'].update(state='created', encrypted=False)
        writes = len(self.writes())
        result = self.run_cli([action, *self.args[1:]])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'machine.pending.json').exists())

    def test_reconciled_current_encryption_loss_blocks_machine_admission(self):
        self.assert_reconciled_live_encryption_change_refuses('create')

    def test_reconciled_current_encryption_loss_blocks_cleanup(self):
        self.assert_reconciled_live_encryption_change_refuses('cleanup')

    def test_reconcile_rejects_postdated_or_stale_precreate_inventory(self):
        journal = self.make_ambiguous_volume()
        pending_path = journal/'volume.pending.json'
        pending = json.loads(pending_path.read_text())
        proof_path = journal/pending['precreate']['name']
        original = json.loads(proof_path.read_text())
        for observed in (time.time()+86400, time.time()-3600, float('nan'), True):
            with self.subTest(observed=observed):
                proof = dict(original, observed_epoch=observed)
                proof_path.write_text(json.dumps(proof))
                pending['precreate']['sha256'] = hashlib.sha256(proof_path.read_bytes()).hexdigest()
                pending_path.write_text(json.dumps(pending))
                result = self.run_cli(['reconcile-volume', *self.args[1:]])
                self.assertNotEqual(result.returncode, 0)
                self.assertFalse((journal/'volume.reconciled.json').exists())

    def test_reconcile_rejects_encryption_detail_disagreement_and_resealed_tamper(self):
        journal = self.make_ambiguous_volume()
        actual = self.respond
        def mismatched(method, path, body):
            status, value = actual(method, path, body)
            if method == 'GET' and path.endswith('/volumes/vol_owned'):
                value = dict(value, encrypted=False)
            return status, value
        self.respond = mismatched
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        self.assertFalse((journal/'volume.reconciled.json').exists())
        self.respond = actual
        result = self.run_cli(['reconcile-volume', *self.args[1:]])
        self.assertEqual(result.returncode, 0, result.stderr)
        path = journal/'volume.reconciled.json'
        receipt = json.loads(path.read_text())
        receipt['observed_volume']['encrypted'] = False
        for row in receipt['inventory']:
            if row['id'] == 'vol_owned': row['encrypted'] = False
        creator = runpy.run_path(str(CLI))
        receipt['inventory_sha256'] = creator['sha'](receipt['inventory'])
        path.write_text(json.dumps(receipt)); self.volumes['vol_owned']['state'] = 'created'
        writes = len(self.writes())
        self.assertNotEqual(self.run_cli().returncode, 0)
        self.assertEqual(len(self.writes()), writes)
        self.assertFalse((journal/'machine.pending.json').exists())

    def test_reconcile_rejects_missing_or_tampered_original_precreate_invocation(self):
        journal = self.make_ambiguous_volume()
        pending_path = journal/'volume.pending.json'; raw = pending_path.read_bytes()
        pending = json.loads(raw)
        precreate = journal/pending['precreate']['name']
        original = precreate.read_bytes()
        precreate.write_text('{}')
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        precreate.write_bytes(original)
        pending.pop('precreate'); pending_path.write_text(json.dumps(pending))
        self.assertNotEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
        self.assertFalse((journal/'volume.reconciled.json').exists())
        self.assertEqual(len([c for c in self.writes() if c[1].endswith('/volumes')]), 1)

    def prepare_response(self, method, path, body):
        mid = '22222222222222'
        target = '/machines/' + mid
        if path == '/_test_ssh':
            args=body.get('args')
            if not isinstance(args,list) or len(args)!=8 or args[:7]!=['ssh','console','-a',APP,'--machine',mid,'-C']:
                return 403,{}
            argv=shlex.split(args[7])
            if argv[:3]!=['timeout','--signal=TERM','5s'] or not self.lease_nonce or self.lease_version!=self.machines[mid]['instance_id']:
                return 409,{}
            return self.prepare_response('POST',target+'/exec',dict(command=argv[3:],timeout=5))
        if method == 'GET' and path == target and getattr(self, 'stale_after_ack', False):
            self.stale_reads += 1
            # The first replacing predecessor triggers the old producer's
            # immediate failure. Further exact predecessor reads let its old
            # cleanup terminate without inventing a successful new-version park.
            return 200, dict(copy.deepcopy(self.stale_original), state='replacing' if self.stale_reads == 1 else 'stopped')
        if path == target + '/lease':
            return (201, {'data': {'nonce': 'lease-owned'}}) if method == 'POST' else (200, {})
        if method == 'POST' and path == target:
            self.machines[mid]['config'] = body['config']
            self.machines[mid]['instance_id'] = self.machines[mid]['instance_id'] + 'next'
            self.machines[mid]['state'] = 'stopped'
            self.machines[mid]['image_ref']['digest'] = body['config']['image'].rsplit('@', 1)[1]
            if getattr(self, 'force_prestart_failure', False): self.stale_after_ack = True; self.stale_reads = 0
            return 200, self.machines[mid]
        if method == 'POST' and path in (target + '/start', target + '/stop'):
            self.machines[mid]['state'] = 'started' if path.endswith('/start') else 'stopped'
            return 200, {}
        if path == target + '/exec':
            if self.lease_version != self.machines[mid]['instance_id']:
                return 409, {'error': 'lease version is not current'}
            if not isinstance(body.get('command'), list) or not all(isinstance(item,str) for item in body['command']):
                return 400, {'error': 'command argv required'}
            marker = re.search(r'CLOUDBENCH-DELIVERY:[0-9]+', body['command'][-1])
            if marker:
                return 200, {'exit_code': 0, 'stdout': marker.group(0)}
            if 'subprocess.Popen' in body['command'][-1]:
                return 200, {'exit_code': 0, 'stdout': json.dumps(dict(pid=42, birth='123', boot='12345678-1234-1234-1234-123456789abc'))}
            r = self.preparation_request
            guest = {key: r[key] for key in ('nonce', 'source_ref', 'node_fingerprint', 'python_fingerprint', 'guest_env_sha256')}
            guest.update(job=dict(pid=42, birth='123', boot='12345678-1234-1234-1234-123456789abc'), schema='cloudbench-source-guest-v1', machine_id=mid, mount='/data', guest_exit=0,
                         installed_node=r['node_fingerprint'], installed_python=r['python_fingerprint'],
                         image_node_fingerprint=r['node_fingerprint'], image_python_fingerprint=r['python_fingerprint'],
                         started_epoch=int(time.time()), finished_epoch=int(time.time()))
            return 200, {'exit_code': 0, 'stdout': json.dumps(guest)}
        if path == '/volumes/vol_owned/snapshots':
            row = dict(id='vs_prepared', status='created', size=100, digest='d' * 64,
                       created_at=datetime.now(timezone.utc).isoformat())
            if method == 'POST':
                self.prepared_snapshot = row
                return 201, row
            return 200, [self.prepared_snapshot]
        if path == '/machines/811d632f2650e8':
            return 200, dict(id='811d632f2650e8', config={'mounts': [{'volume': 'vol_r1jde9donnx2mn9r', 'path': '/data'}]})
        return None

    def test_real_creator_preparer_and_authenticated_successor_retirement(self):
        if getattr(self, 'machine_reconcile_before_prepare', False):
            self.make_ambiguous_machine()
            self.assertEqual(self.run_cli(['reconcile-machine', *self.args[1:]]).returncode, 0)
        if getattr(self, 'reconcile_before_prepare', False):
            self.make_ambiguous_volume()
            self.assertEqual(self.run_cli(['reconcile-volume', *self.args[1:]]).returncode, 0)
            self.volumes['vol_owned']['state'] = 'created'
        self.assertEqual(self.run_cli().returncode, 0)
        helper = runpy.run_path(str(ROOT / 'scripts/cloudbench-prepare-source.py'))
        created = json.loads((self.root / 'journal/result.json').read_text())
        ref = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], text=True).strip()
        image = 'registry.fly.io/navi-whisper-lux-bench@sha256:' + 'd' * 64
        def private_write(path, value):
            path.write_text(json.dumps(value))
            path.chmod(0o600)
        build = self.root / 'build.json'
        private_write(build, dict(schema='cloudbench-image-build-v1', image_ref=image, source_sha=ref, source_dirty=False))
        self.preparation_request = dict(schema=helper['REQUEST'], nonce='c' * 32,
            source_root=str(ROOT), source_ref=ref, image_ref=image, node_fingerprint='a' * 64,
            python_fingerprint='b' * 64, ownership=helper['descriptor'](self.root / 'journal/result.json'),
            build=helper['descriptor'](build), native={k: created[k] for k in ('machine_id', 'volume_id', 'instance_id', 'config_sha256', 'env_sha256')},
            guest_env_sha256={'AGENTS_ENV_B64': 'e' * 64, 'BACKEND_ENV_B64': 'f' * 64},
            protected_resources={DONOR: VOL, '811d632f2650e8': 'vol_r1jde9donnx2mn9r'},
            scripts={member: helper['sha'](helper['source_bytes'](ROOT, ref, member))
                     for member in ('cloudbench-fetch-ref.sh', 'lib/cloudbench-env.sh', 'cloudbench-sync-deps.sh')})
        request = self.root / 'prepare-request.json'
        private_write(request, self.preparation_request)
        output = self.root / 'prepared'
        env = dict(self.env, FLY_API_HOSTNAME=self.env['FLY_FLAPS_BASE_URL'])
        originals = {}
        if getattr(self, 'recover_before_prepare', False):
            # Execute the exact old producer against a real HTTP accepted CAS /
            # replacing predecessor readback. Preserve its genuine false result.
            capsule=self.root/'old-producer';scripts=capsule/'scripts';scripts.mkdir(parents=True)
            for path in (ROOT/'scripts').glob('*.py'):shutil.copy2(path,scripts/path.name)
            historical=json.loads(zlib.decompress(base64.b85decode(HISTORICAL_PRODUCER_B85)))
            for member,source in historical.items():(scripts/member).write_bytes(source.encode())
            for member,digest in HISTORICAL_SHA256.items():
                self.assertEqual(hashlib.sha256((scripts/member).read_bytes()).hexdigest(),digest,member)
            old=runpy.run_path(str(scripts/'cloudbench-prepare-source.py'))
            # A test-owned sparse Git capsule binds every historical producer
            # dependency and the current image-input closure. No child commit
            # or missing parent history blob is required by this fixture.
            git=['git','-c','core.hooksPath=/dev/null','-C',str(capsule)]
            subprocess.run(git+['init','-q'],check=True)
            common=Path(subprocess.check_output(['git','-C',str(ROOT),'rev-parse','--git-common-dir'],text=True).strip())
            if not common.is_absolute():common=ROOT/common
            (capsule/'.git/objects/info/alternates').write_text(str((common/'objects').resolve())+'\n')
            members=(*old['IMAGE_INPUTS'],'scripts/cloudbench-fetch-ref.sh','scripts/lib/cloudbench-env.sh','scripts/cloudbench-sync-deps.sh')
            infos=subprocess.check_output(['git','-C',str(ROOT),'ls-tree','-r',ref,'--',*members])
            subprocess.run(git+['update-index','--index-info'],input=infos,check=True)
            for member in HISTORICAL_SHA256:
                blob=subprocess.check_output(git+['hash-object','-w','--stdin'],input=(scripts/member).read_bytes()).decode().strip()
                subprocess.run(git+['update-index','--add','--cacheinfo','100644',blob,'scripts/'+member],check=True)
            tree=subprocess.check_output(git+['write-tree'],text=True).strip()
            historical_ref=subprocess.check_output(git+['-c','user.name=fixture','-c','user.email=fixture@invalid',
                'commit-tree',tree],input='Historical producer fixture\n',text=True).strip()
            subprocess.run(git+['update-ref','HEAD',historical_ref],check=True)
            old_build=self.root/'historical-build.json'
            private_write(old_build,dict(schema='cloudbench-image-build-v1',image_ref=image,source_sha=historical_ref,source_dirty=False))
            old_request=copy.deepcopy(self.preparation_request)
            old_request.update(source_root=str(capsule),source_ref=historical_ref,build=helper['descriptor'](old_build),
                scripts={member:old['sha'](old['source_bytes'](capsule,historical_ref,member)) for member in self.preparation_request['scripts']})
            request=self.root/'historical-prepare-request.json';private_write(request,old_request)
            self.stale_original=copy.deepcopy(self.machines['22222222222222'])
            self.force_prestart_failure=True
            before=len(self.calls)
            failed=subprocess.run([sys.executable,str(scripts/'cloudbench-prepare-source.py'),
                '--request',str(request),'--output',str(output)],env=env,capture_output=True,text=True,timeout=35)
            self.assertNotEqual(failed.returncode,0)
            old_failure=helper['load'](output/'result.json')
            self.assertIs(old_failure['qualified'],False)
            self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,_ in self.calls[before:]))
            self.assertEqual(self.machines['22222222222222']['config']['guest']['cpus'],4)
            self.assertIsNone(self.lease_nonce)
            self.force_prestart_failure=False;self.stale_after_ack=False
            originals={path:path.read_bytes() for base in (self.root/'journal',output) for path in base.rglob('*') if path.is_file()}
            originals[request]=request.read_bytes()
            recovery=self.root/'recovered'
            result=subprocess.run([sys.executable,str(ROOT/'scripts/cloudbench-prepare-source.py'),
                'recover-bootstrap','--request',str(request),'--failed-result',str(output/'result.json'),
                '--output',str(recovery)],env=env,capture_output=True,text=True,timeout=35)
            self.assertEqual(result.returncode,0,result.stderr)
            authority=helper['resolve_bootstrap_ownership'](recovery/'result.json')
            self.assertEqual(authority['original_creator'],helper['descriptor'](self.root/'journal/result.json'))
            recovered=helper['load'](recovery/'result.json')
            self.assertIs(recovered['qualified'],False);self.assertIs(recovered['credit_granted'],False)
            self.assertEqual(authority['machine']['state'],'stopped')
            self.assertEqual(authority['machine']['config']['guest']['cpus'],1)
            self.preparation_request=copy.deepcopy(self.preparation_request)
            self.preparation_request.update(nonce='d'*32,ownership=helper['descriptor'](recovery/'result.json'),
                native=dict(machine_id=authority['machine']['id'],volume_id=authority['volume']['id'],
                    instance_id=authority['machine']['instance_id'],config_sha256=helper['sha'](helper['canonical'](authority['machine']['config'])),
                    env_sha256=helper['sha'](helper['canonical'](authority['machine']['config'].get('env') or {}))))
            request=self.root/'fresh-prepare-request.json';private_write(request,self.preparation_request)
            output=self.root/'fresh-prepared'
        if getattr(self, 'fresh_prepare_ssh', False):
            self.preparation_request['guest_transport']='cloudbench-ssh-guest-v1'
            private_write(request,self.preparation_request)
            binary=self.root/'flyctl'
            binary.write_text('''#!/usr/bin/env python3
import json,os,sys,urllib.request
args=sys.argv[1:]
assert len(args)==8 and args[:2]==['ssh','console']
assert max(len(a.encode()) for a in args)<32768
request=urllib.request.Request(os.environ['FLY_API_HOSTNAME']+'/v1/apps/navi-whisper-lux-bench/_test_ssh',data=json.dumps({'args':args}).encode(),headers={'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(request,timeout=10) as response:value=json.load(response)
except Exception:sys.exit(71)
sys.stdout.write(value.get('stdout',''));sys.stderr.write(value.get('stderr',''));sys.exit(value.get('exit_code',1))
''');binary.chmod(0o700)
        fresh_calls=len(self.calls)
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/cloudbench-prepare-source.py'),
                                '--request', str(request), '--output', str(output)],
                                env=env, capture_output=True, text=True, timeout=35)
        self.assertEqual(result.returncode, 0, result.stderr)
        if getattr(self, 'fresh_prepare_ssh', False):
            self.assertFalse(any(method=='POST' and path.endswith('/exec') for method,path,_ in self.calls[fresh_calls:]))
            self.assertTrue(any(path.endswith('/_test_ssh') for _,path,_ in self.calls[fresh_calls:]))
            prepared=helper['load'](output/'result.json')
            self.assertIn('ssh',prepared)
            self.assertGreaterEqual(len(list((output/'ssh').glob('*/result.json'))),3)
        cleanup_args = ['cleanup', *self.args[1:], '--prepared-request', str(request),
                        '--prepared-result', str(output / 'result.json'),
                        '--prepared-manifest', str(output / 'source-manifest.json')]
        if getattr(self, 'recover_before_prepare', False):
            claim='cloudbench_source_consumer_'+'f'*32
            self.machines['22222222222222']['config']['metadata'][claim]='durable-open-claim'
            before=len([call for call in self.calls if call[0]=='DELETE' and not call[1].endswith('/lease')])
            refused=self.run_cli(cleanup_args);self.assertNotEqual(refused.returncode,0)
            self.assertEqual(len([call for call in self.calls if call[0]=='DELETE' and not call[1].endswith('/lease')]),before)
            del self.machines['22222222222222']['config']['metadata'][claim]
        result = self.run_cli(cleanup_args)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(set(self.machines), {DONOR})
        self.assertEqual(set(self.volumes), {VOL})
        for path,raw in originals.items():self.assertEqual(path.read_bytes(),raw,str(path))


if __name__ == '__main__': unittest.main()
