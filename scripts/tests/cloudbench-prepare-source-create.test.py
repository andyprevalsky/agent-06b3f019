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
# The complete original twelve-file closure is self-contained. No current
# dependency or child Git history substitutes for the original producer bytes.
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
    'c-ri}YkS*9k|_LFFwV0>G6pHhb}|_{$gX136K!nEucTyVR?>q&Bq(7_0$hTWt$1{P`&+lZqCrwl=Inkr*_}iLx*Ofq)zx*cPmjj4'
    'YCXBi%kfP=TaIsv+kDcWXYfav_m}y)&IgOTN5e;7{9$ihFZZsBaxX7$qs86orYfIaloyZi|K2V0I$vVfqnD8yCVIoeMA>9s)OAsn'
    'gXnF3n=hkDKFe2m1f8n&a-7#uwT!CSBpT1MVqOn;Oc=YIE~|NzrqlImz0A`zD&~u7xr(x~tXA0yMyxMN^=x^)$d+}kAB?NTo&Ir?'
    ')i<-^O8@>xU6uMrRm+za*$P{!&%A@5y3x{%yj+(!G<8|sEnxog;!U<#6y^21W%cpy3|`<8ei)sMqJ+lk!b*x6tfM!;rO$5jZf^jS'
    '&db$BdHUjq(VIhPc@f+a+KT?|0m9|<?D*vHFC%KZ%vTw}c+$VEX6t$0pTfvD{p-BUmjobe|K{-I$I*#5bgG6<X=rSB`0gDwDzn?7'
    '|KX;n7x}V3TYv0R2W)Y6c=}^{GI~YL4xWDVr!4<^|C{_z<LT8m`P1os_RXKZo@816=O_DremebX|LN7UufO80yeKF6G%E9a(!I@Q'
    '>pTXCX0Qvr;YAt2KLxz3RuR3ENBGY&E9yM@8J~`p%WBz`US`N~R#s&(&SpHW8V>-oUY4}cgUNcnsMTj{*s1h=epe@FOZuI|7G$ex'
    'Sts3#M=|_AtZjJls24}sY*u|p%dAXZWwSc(4FC?+1a{4Qy}rr1%j|>qRYA7_ynXW3*VJHelYg8P*Ll6NyN|1KT3n|%N@(`@++Uy7'
    'dtOb}v%FhobH5{@=m7qmB2IVf)v`;7xEE1l8RLuS>?Q}~ov&Bf)hv(dGF#L)unU02b+iHufTOy|;albSZV;U?(niH9y2_{3GKaxd'
    'fI?9|o#x|J9pi{~6)l#<ZARyNoEHl`I@zS&`>-rla8yd70Ly$<Ws@kAB}DMOVgi(+jH)Z7B!s(zi!yz8a`f}z*(g0a2Aq@iIwz!B'
    '7S~0Y&A#5>@56cl?}1>!?inb_bh-!$4@}nZ=XjQ~$;G2fZfI?BcFUdP$k`)&q)xVUQIF+R59aSD#j*?2&XfJ>Py73E#4i-?<sXZB'
    'l~(WRr}TH{gdbOPQr|aI%Rgpg=)X)KI7c{aG)?+`-R)Tij!r0@8r-3}>p-s;B}pXb=;G02y(F|DvK@_Yvhq5g5a@BB98QciZexaK'
    '6&eB4VxC>+?n$8e6g42oDl5miKE<nL571=-)A$cQWpHExjm+!}S__ua;IQ-my)Ks4JeT>RstY*(cX7lAG?FzAmi1y*th)9m;^?4f'
    'O>CJDrt8^ko~_0=(C&P{|L3efz5Mj`vwLjI<MrI>@I2&Gjp@MF5c$Ein5mhm?C~7V`v;dcnba*|@}X`r_4EBpmrgVmZ?<IxS8BdW'
    '@tW%jM-WHV2RLE%O|gj8J+C%uUQA$XiwT}nZVl*L;DNGw!6Uw?QhH-S(yYbwhAm$q_9NEeuWGSCNYTDas{u?AmZ#8zhV8{>u!~2U'
    '9RWf*DJDpm=Ia_sSR^Ax9||}nbe19@PBmSdGKTERczW%ui|Mvr!Ms|-p@tUFPG-c95bEcbz2G`$dD-PwbgT||S@Zz5Nrqu)!J6pg'
    '0dzx+@K{L`KoD4BrsvNvsDbDUhY->G2pG8uuqqb*xeNB@YSy(t00GfjR@G`s>of1J*N8yy=+k|#wK?z?cm=?GWy12)nJ}?25qF9f'
    ')vOrb?K)NDBC_(XtEL54eJ_IBDuO@oP<3hdh-+HPgci#RxX?P6pNLA6t2^~;e3Rp~gA;b<xGwAU0{K3`AR#fc?5<j`{0RaH1rj~a'
    'mha)_b8rNhH`y%>GG^9v&#Ib27kz%DqszOc)J#(l4<7E<lgMHysNXp<d^me)14!K)Omb#)=%%1aAUTiTR%Px2!5pf3Jw_k`pvQ2$'
    's>vPg#1)|GB)YnThfBQq6xHxyB=l%fj8{!k0H-=Z@?u_SB9h!X&sm^IEpm`p#K<NRm(5;=83S6MSgaZBn7wKu-~jq*Vz!c=xugd<'
    'E$i#})BWri7!E+5G+SBC%tN>FGQS48WHsamZleVpkDPZQF_hZ87vQTU%Fj5AEQ$T2(Pma;R|VWHMP4TtkA8Z4GCDne{qyMMbJ%u;'
    '3ve~=(dq63;PIU70WQIY!GrNE&&u@z4&*ckycjzOVK_JB%@Nf9jg+OUrVo5x9Yfb!Kq$DnQf4d0)eRiR7?|&62_MG|LJn&@TTk*y'
    '(uG@iUBYRZP<Q&hz@=Hg^N$N8FzSKBg0$WAPoL0D&mTuY7G+nu@%chglCgb0xNYO=-}s$p`}7@aae<G?+X&x=hj*_Z8=$@DJ9P=+'
    's~XUHo-I&x&{sXTW4hhw?vRBE(EOqtqZB@0kgzXpQ8KApNjXRi6`;!<jR<sa2E%l%UF$`U`I)tI`kB3Z_L3W`alT?L$9-<Chj?9J'
    'q{c|+P*(x1W-RN={*t_+2gXHeuz!KlE0ahNTVN%EhIY?7nik6%aCdc+mkMX`N3o3HxRfh8XKK8voZUsNeE{*Tn!$Ne;H^9ADnh_#'
    '%K{mBl=2E&!vde4!~Hi9-X>cviyZm3^GoN6QW4aFSH%RMB3OIw3#QE8%bR>QN$YX7pckL+`KfGdV<^23N<9RhcZELg*|#A`QeTXa'
    '=i46sz}wzJp3Cs)AOx*I#O=CYU<BLc3pOe~<O|rU92c{EmyZN+8{Yz4fx(JZEC0iefKabzD<ea5&)zvQKSX3v$b?~hvf6809wcDk'
    'VCR|-(R^?Sc?NJ$aP>-DFf9=)^k{OA5~i4I-({df@*sAIi2(E*+J(=}(WYP4fu{99>uff&2O}9qi<S;4?r2JU@a(=5qqxI61b-mx'
    '=?k&<3FJ9$@$~arZCU{^$5UMyLSeSaIubN&^v~#%X0!n820kbp;Uo+jMra`0qn`p8FYi4VGR0G$b0LK!RloKJ3arv5h)wF&vR0Y}'
    '@`%==|7a0~*de<ztmu^YepYgk8PD__tQR<0dwCZ3Hl@uNx{I(V)BxZP+(!mo71A117uJcSS|V9J^)U~{a93zNvm=D!oua(SQ57~x'
    't#5V+%e^@X7GQ((j&&wFmu|Zz-_WrY5iqul;jW=`>7NL7DyTWnmIVx8N+-pt1L8m(kt$RlH5+vh9{9U$*x&E4;aB3oS32srX&^^8'
    'c<s@GI=!8?yaiVNcDqQm;~Dfem{le$mM2l`36GsuP5p_32M8fNR4@nou0{~cm%O)fVL$Y==?~g-Ya9|pjg4mr#pnjTP&duIs0km!'
    'A4U;K_qljv)+O^{$-cl#)EXNw7#o)P2WYv-#>MI`V)Sl&#e&};n-FMQS_llO75^P>sO~~NM`^~YHk&sJuwJwLIvd}mTCTHN)3a1`'
    '>0v#&wj@#8KB~TyqMQV3=25Gq(l*Fw4ufDA4`DcL0bm&76uhBW#Yk2#<TpqyO{~ryi7=>4*;5MrdH_%vT>t893(KB(rZvwvSeLM`'
    '-7oP((%g7}n8>GG%<7l}MVQyD)!<gqA2fd2WNR_YO4b51P`d7J2KXc+X)5lePH=kaDc<4sdHkon6f=4c`TJKu2Q>`Ql!T{qp3kq8'
    '=Jg*Hn*8?Ij5<Lh(rQ`FX2=PGfW6Ac%u0G!t=^Rcet%qbCj>22OT-aTRa`ZxNfv9=TwdDX!e#?N-5PbJsD=(~Q-Cp0-xT9OG+8f^'
    'N1*MPMEMNHAT7e3g0;^i_*^6@h|Gc$nX`F9RHa4F5%JOzf1y2(k`rAv=gfdc>)rHA3rrqy_mAtjo&^klX)E<C_OJS&#a{WOkOrKk'
    '%_hQv(PD<j)kDs%eMbJcdFE&a?fUn1KXMS)e`#THsGodK@X$IA?h0In%&f-);xhY?>Vwv#C-55Sh<_Ae&!aD+gZ(GZ<UhgdqrpCi'
    'E!TXII2#{X&e51kl*^Np2H8~&v>$kbUhgu%ohUu4F|&H70x1=fXXi9{LwRda;B5lu`@_=_&X<G`o+tv#vhBHx^?}5bg-gaW=M2?1'
    '`K-v_a7fft?gP+9{*Xu1?4oMkb6F2%t<$?M3Xr?T{cJIWHL2md29NyHD2QfpNBo^YGrF&Vo)qOeZ@y)^M^|;YD>n$g+wFP^_YK`y'
    'Yz@*pakJxn^O3SCY$6QjNTPPJHFy&w&>9Y(+Qy{R@1fodUn}^1%hz{!t<+Ijkc>_{b?JIjIiSzTgSU0Hyld$LG`V@U#A1R^Cn=L?'
    'JX_%r%xNOH#@j(39w)F+pwjtbW%<W!Svay6hb5^3NibqXVEvqRimXIdmKtTo0cJG<#@4>A2hFeG)uk?J_}jZt5r`-iK_g$to#Im?'
    '@(9Hu%|@Yhp_9P6!kcNNu*9)o`yYwrvo`FFO}indZIaI#3z8GrdaF6}gwbx`zK3%$&SrFN!%4I0|7AO^5q+62R}B?CY{$n<RO+`<'
    's?VlYgyeDCQUxyqt8Ln`Lier>9>=fBM~z<l9B_AJi)MLNqXlEg8j<#Ci<FrvDRUU@$6G12FUt!X=w6lD!E(H;>e{ycX}-BZsb!#Z'
    'VL~+;Ix;2;9f)@ugm=ObwY5eVRM&q)B_fQY?`vcq1o?dPQ_$U+T8rX92_<@32tBmY&kD;BrX^;PqJ2)CE}os{6}J<Gp0DY2x51Jw'
    'SRsL?bvhvSh}MpZG9_fyRqhDw;4ojC6w@jE$>yWmd|6D<^y3@lz1t=*|2B=3Ge`fOzdSLC`+b_0^41k9W>Hu~cX{se+ZI<$+c$B;'
    '4b;4S8rbX(wdo)$6Wkj`gRJ?f1KT=s;23MESu9V!O~yBmeqs{nY?gIx%M=FW6$fPhUi0wsrspq59eYo4NFTHyP*%coG@Z0+%Rx^}'
    'SDteSI_Au?gdL}CZw|Oi(LsaUF2z^c_JLR|lEZiJY(EUL$0y=HVA-dPtv#`w3hce9-_vX57~S->sFn7iw!f%XnaEA;gE&TarDT@P'
    'uO?Zv97f9qeX%`Fs+4s>>{jZ$z{`rPzUs>I+mLz?ojg+UP)Nxq11L}8Uu?dL3v~c$0gld~=bH7!<RZ*N!zy_$Yz!+dY-=bpKj-er'
    '`_#OPhMHHgp;TL(5Lpb!U*6a=^xb{mlq)^nM@9*-K-Nk1T`O^I#+gM}I^)eEo~kyMk$=@N=&r#YsVovP=8MOl1P+jb-)>`_0@YID'
    '2K=UQBBX_TE-oISlXr2AYXPW5GVv|`clOBYe8})Rd;n+AwOv`@5~K^TT5^9x3G-U+2<wUKZGxZKQ@$??)I?~*L13y|JbCQ-Gf7}S'
    'KvHm87G2+;$IvTQ;yL3qshV%c#$L7^n|}j3W9SU|ncx<*4dlA@d|C#L#7iZD8TyUCjNP32H7|jdZmz?R&y;GLk-G!=#|5he*$X-e'
    'JAd0wb%H;Z*F#vC3@|DF*w7<1GOo&<SA+Fv#55@<Zj0T(FsBvj<HZ+nXI`oeArIJz+!0TN_%}_av~lVAVgJ9f{;x2?<zv&=-qK!U'
    'Z3>}PIF_Yw+kFZ2ou>Dt;`+Au$vfR0H_YIS)tM0PPkgrblvDPGS@Va2^2MjDUC7aa1*QqPRInJrKCS`j%VJ^ZN}wU^$R&{sCqT_h'
    '9T%lFpW2#}PvYpySb5E*%B4`El7@~2&%0k_0+yEe)7(<zvJRC5a`n}Fk2ln6T6Or1#@OZhHfU`BdkvGDx=v=+Nmih3vz1$07v!le'
    'Fj<xdeOAX5FNhBRL_}RdP-(lgcYjSJB6R3{R$qEr0$l8PL}ynuz9-_K8yi);Zvt^Qces<u!ca8F7Ot<5bMM9Fxw+IXbuf?pFle|i'
    'mU0Fq^H0&b)ZVR{Kn972cN8%kL44E@(6NG!)kI^ArBiI#5RIw2PY<=rUt_qHFnpvZ%_ntaMT<qV>KfHQ5uZN)ta`$R9-DYx{VNW&'
    '5FQhQG!l1SHfx@L&}=l%Ao+U#AnHf0J=EM&WOwQW*JsNx$^e?yvuaf*2TgbC2H55MEgYv8VKWgXF0c`n(9?*_VPW3tDboF>KDH0M'
    ')w9ht{^F57>DYq2Jd{E}N2P7#S>4Y|*inz7Ma*<maEL@9^+a_YK7SN0(Y2b#wxqBvfXS>mc%`;QVBoy><Tl*6ax1nW5YyEByniLT'
    'bdKLP0suW2pU)d1P5SZ)Od=FUMHK72$<uiA5kDtApB;8S^yT*89D$EEP?<0ZKlsdM3hFfmL&0x~hf%?k$|kI&iEtc5RZY_=ML*Ns'
    'P8?HgI<=hOEsUk^uB9DKLyCzd^f=LU;}y^*NBB{lv{%214n{hqVuQCFKz}NZ@W=4xl{W=La#-}bx5%AtOq^Z<Bl#XpccbLE9kL=r'
    '`txDy;i`I{mj<pbIlx2$-A2FV1SviVDFrGbR&FQV{@iMNiGdvZ&RSW?W>!o~Wlw{RQFZ=&Frb_XR2$SK9L4?A9=eMO)2_(_M-3;Q'
    'E#}<pvtda>ca8<*%U<t%`1FZfDHPtQ10nYYmJggsi%{=fJc=Ik92AEv;dwi18AWLrny%G|6mP{Op+DkaU|VQyp+L7L*=t6y>1ZcU'
    '$JcH{Pg*3RmY6Wri(F->r%U}Vb&3S<di02-2`7vLL?F?B?GhyTnR?*Xy)jtwe`DvwHc7#P4ucd96x_@SNsypo{F?!Sf%wSX_>5qP'
    '<YpdW7xb%>^DSbxIbfFHeYq3X&}L%igfIrlK{_dx3H}jN=)3+2v;YVOKJsHYt;pD<5en(Nw$FwkX#CE(MNuVhhfmrE$$D;JXeSII'
    'tmW^@8ORnztj-5>2U-s)fBAs<2kaPJ74qv#-8-A4=m+BH{j>4=vidN~C%{T2)`5i!1*RYtilI8niV@)yJ})xj3*e%uqr-PcdvpOl'
    'kH`$c#y~OYE1oq2t^q}%jMX1y6`h_Po}BHy9K9Z$jdWrl$Bk(#Z{)05CBu-P?#s{0*Wu>iP@h4EW<D5wBFdEhh_VhnVuvVpj!MKu'
    '$`0H`@0p&?sSs_DxYo-V-*ifK!M7UpviC^2X;78}K$Zc)pS;;^pKYhDs~N#gN~?77=r5x)Tm*c)x2d~{cjs{olgUatD@nlCIC$k('
    'ql4HV62rcmCPijxXPw|=0Y-w0EK#r*)|24rw6(;wsHhk`+k81m4J3y!;4;)QbLwdf3HE^%-@9-h6_V5L#AELqrBT3W4r_S*VzVES'
    'PQ1|CN)*wP27m&M>>Fxp>wrqQ%|&RQ@6b%$soOtn-Ow8v_a5p5h4|4YXFcYhT?>S@HvsW52ufie;t=kYD?aRj+&?x^qtEuawGg!4'
    'Ztm4~LIr);T%`jKs~-oMiRNh&{ljEgOi}Hd!M~R}44OFnE$7Z9;muDq*AI|Z)V$f;<4;{E8^+53p_S`udXRd&Mv(e#1Y2)2D1^mk'
    'FW*q8rjVyNfQv$&$;<bO^}>`5;>F=9a$B>^ReJBB1#Z7vl`^!?E7w<Ra}2?bgc1V6rI0W1k01*Ao$Ro{#w~TuH<Wna$Zg~Tv+ZuO'
    '>{I%dGS9vM4rTeCd~_*o#(F_lceP$cvus`B&2k+TtLNf6gY87)1<mj3C|j*E%vm$=mqVCVtdvLTqw$>F7xBuQ0a*BkE1+db`uj%2'
    'uy@K~o3~O1onfqLQJr5E*XwFs3-WMS<uKA=@e!k$$`|+U`1GvJw72Q}ZkeGsua=|h@u}@cH)_uzLw|awtruPoP#2%;@}Sp%hOmP>'
    'E{EnKvx^_Fy83;wNEr!<1>R{j0o+0I>6sNY(`vIPE?X1M^+h4X&92bCv4GuLp~rF?2$~~UTg-#GH(C<|8YjWV|LE|=k4+t<2T(;^'
    '0Y^S$#VS?oWfvtu!U9}Z9IfDX1geod+27)eD&w`9B6fqNwNy3Y4&Z2xV|D&4R$M_8ucs?KN(!FOBhHqpb?@TuparzwhrYD(1}&%2'
    '<_WB|Z)FO82ZkVUVqFHnxGKySS#e#a+R6f0H_1O5p}S#=U}62Z6g$8Is5o3*GhhkSU=a<0LXu7wL~Lxas-szjrdiQxN5AIF%8~w&'
    'U9Tf;6|mL*^hz@t4@ntH9tg6|Y<Yc)5j`}TN%}~5MBlaa|8S)*yB8OePfzcA{eRG3&+dCc3yT{5AJvs(W3hDZ{E3i$UH4v9t89j2'
    ')N(+@)-4QyW#iVMCeR16P0|h!<INvFe*y=!A01c|+DB_TH~bdA#FSZgI8dxRHrU&Xo<NJo(E*#}<m<@&0e`f|jT&M7TZ}=*3W6Wn'
    '-(-8B;AY&ibN<x7;dFd^sZ5G26E2?ZX#EM=Y7FYER{4CfvWzwjTTQbq8Ep>26O~5Bf)dn<(}FEye?DV}HpN27e<eg#{Q}AmIJ-1f'
    'D#>H3dXSg5#S+9qUg?Y1$3MONe)RUm59#5_iyw}D9=%LYMn9d7(xbO8M}KpX3%~FggQTZF91_X0ci^h3W?eHk+HLC@d`Ubsb=EQV'
    '{$N~?l$Um<RWsJmR$Ton&$xHaJ?Ei^pI|yLve)eg+13tAL}Q3Da+Yy|iYAFXcr&_j13nqB#s&#uJ<VOY#4Sc)<OvvVZMNZ%uOrL`'
    'v%+k07WM-~ghoE(4)pU?@eqjyL2S)M?=ZhaJ-BFf+Hxr`vk#>CX6=l<5&nl&dUDHx&U>L8qvT<9b%)8heHRXEpG`Up<6-EAlK0{*'
    'JNCQ5lo8l6z1n_*O!+VM@rFx_b6EvjTb4+bUhfbo>hcaVZ$z1F1**nGqeR@yteED=UJs(9m2!%!S2<iE$h?p#M-3;`yHjheaJ95-'
    'jHn@5&Y`2Eyroa;iU}}ifyqE9f=y-gfR$~%OrnFK4=-npFsP)VG@+)<#S@t^sF+<<n6;7OgpF-x5FLYbu0~tk<h7kgep=)+$vK1>'
    '3N?AsiQ!>B08!uw@wKg~8#sn6n6zI~q5H|cA|3o1w$cIjS`|CJ-8^Kww+)WNXtjn5r5l*dqt<ZLkX`e>w@GpA1ylx2pNgj4_q=Em'
    'L)@7O0C)m{dx20r0ZHfu$`Z2~(1h=^Iv-Kocu_SBcGO5`N&+chkzJ#h#R1~1TBS|PKac~-M67v~+R`rFVVf&SYnWr=SBi89+v(y6'
    'WYxub<<98)0wuySH`yymok%PwoHTXOt7#}j8HX@Ysu>>NkshR6#})MW`kC_x1<nfzi{|MlgP}~$HK4-xmXzj*o9<bW0&<s1OXLFD'
    '8{sHgvT^UhPm2NavxFLyiAI?!3)l%XR`x6{T|#QTR<mQf)-<RZyZ5qPqivzI_F=KUBG2zYx^zia6h~}oCwYa^RmJqbecJ<^UAVgr'
    'NPELA(FWB@mr$u!OOUJCBFm0>)k@r-p;b|*1f>Qiu(-La$^F+Xh<Y~sp*(JYHUb%AoHX``qc2tV5t`QZth$1$?@PS!g0@F;s%HT8'
    ';Bo@O5OZX?Qlry5$(+rO%ifi&!>o`Cz&Z{y#M|y}W*F+w20Y3nUxqA&9G3&^!y0YU#L&YX4?jX#0I-9u=7OEjq#pe-+OPKi^rxUL'
    'M_mmKFa-A_Y&%6D3{KOd)0amlUFXxGd?2y~l+K4(r;T|Q-WMe)%Q1)95^gi{;BU3k87KImAHCSvL!9Fzzm0cjR+QB)&2YuLv|Br='
    '(_5Qe@7AoG73KSuhL_tD9(XM74mNMS-6x~Jc-!q_EX|BcENsf_AZQ2NP(}%~IZ|Z1;k3z+dyKf&8W0tHED?0shu(u$%e}vaMR>Wb'
    'bo8D_Q?@Tv-N+46v)iIS_W*JBzt;J=Svp9r_<zT2w`1lstczcFn%*4cn6#{SX*=HBc86oGJao?yV-R65h1+L2ba`jRl0|9!9UQT2'
    'gD<mAlH6(-iCdPJfn$g>aoHm4G^x>z^zJf6;uW84oNAauQ!{Ot%y~@ZQ608)bDMyn`?njpHygNp<MwZ|LO)=;1H5cwtIKe1Azl7w'
    '7-_I=G{iJqRfd~Qer?zz?l&!{gGTY?#7+iFrRhlH=Lp2g9@4NsT|8PXv$94Zhl_E9n%t~bi}trQpviJMkXsIbf9*ApEZ0s~D;dy~'
    'D-{6Wj4ZwpU^esm+)MNE8>5LO`a-%;rMo~98DEZ3%7!pwXJ>^4lBLsgs(GnZY%zET{p=RFEW8fec<8Q3f0$iKHk{HKyNYRC|K+D='
    '_bf+VXsM1nhthFtX_A)IZWG)FGR*5f&Bm)Xh+%?B1-0{q_gShfH1HG4(jt`m$Ym&Jy&99NX1THxGGc&+i>j=1WiMfnEtIv`(QL-T'
    'y7@+3kGcrz?ln$WL&fa()U!R`zr1X5khsDudx@wc23KD{6S4_?f&Adx6dsZThEl=W4#=%p1^)Y7a(i4#ZjYv|oj(CY|E5yeo4B8T'
    ')YgY<j#)kAL9;y)LR<t(=hRv2!<wzhwkEBB!C$kI)(?JCt<l){tsYgi2M+k@{{F_X=M~7Oc%P-E{e=eZx1g3!r@b9j!nuVF1OdmJ'
    '*+D9ca^e9&+}X`<c_XS?qh4CI8$$xPeYh##QfP_(@#bqug=lxxfl?(N+cT6%Pny$LcK(rr%jV`-SxC4WCnEW3i+)NGDGJ2igMRt4'
    '<z5}20;lUITnbI4CA5{t;T{GHY1;J0nmfm^KG_Gt^#rZ<&c7~OxC4!MJa}|V7gZa#K&sG~tq`#|7RB1F2F+!xEKSs$HbxV)Mj!Y<'
    '=q`cA*`x!$#7~4Y^cov^>2PJ92-nqaZZtKD(4mPpU4GoCgm}|95ADjKC)*~`wsCAjQfZW^1a1Qffvq0rl!g$7J%6I&kNtoM%$7!V'
    '(!w}sxyn&H-!G0;ayWqVh(AiZgcQml$t)ACRx{*k556H6lSy8Wm&IZwOtO_3$F4DHMKj;K-)k~LOH;@4CeJ2Pl+mnuI=j;a$!WHI'
    '1qX8WaF?Xj$`+EH9}I1e+m@Z;BhhlALM0U)ps55_?qan!*Y>7zCU<DbAAdr0gk==>J)ieYTUv%=B$VV5|Bk|u<uHofys*?ZVF)ce'
    'Ejz)kv9iV|VM-+KikhL>maxM0G7Y)CHcrxJkH}4)r7e&Pb=LB_@tka(xJI=nmyMtw2NgAa*_6<uWna)awPjzFStQn(v?#9ws|W)X'
    '5{jvAc&?O#Qs<ZTgCXt*Imu={YHJ)PK}A5(>H9a3K80<R+C0f-I$dzXHM5dmt-SFPt85;I5;&2?tiJIxH=*6AcJmzCCPyjS?wX*K'
    'SlHcUacnU(%91X1kl>oFb6Sz>Smt<kA+uN0-gVzlPT-g{0uZF2k8JOr<Uj=(cE_-a0dnaQnIq?n*NX0csxO5MXq4{O-*AJb%%X3^'
    'QOnQT6i{#4+H|g&1_z@ZtAn~{`)yO@Y`+a?n(fz31+)G3dgEJPoqXvWQI#EP`}x#BcnnamKR{||cQs0h>^xPfWnbhs&^5`bjNbn;'
    'XgY0X|LJ|^vNn(%HAoB1p?V?C1QfN<5iY6mj$qgQEuIlTTQSAI<80UTwq`#f&Q4A~@Zz<R2|tAOM&K#zd;VNU*VMWA>cG_-a+R2C'
    'yRdSU0DcyTjQwbJgI_}rOXq2!NSEq)SGx_C**Hf(edTwdW|yw=kE@XD=*drSQ}!Hvaroxl;n82-rlTjL^yTRA<?Exjqx8-3+vBt2'
    'w?{AZzH8N<=gkpv#-OM+wMT`xH+aJ|0>$-x;=~7-&pN7o+Qp`ZH4q*^EmKrmB&55b-@QRfPVQ+M2U;gcak-uMS_3-4?Hyndscxtc'
    'hO`<?(JyV4=E_y5YfV9;BCjP)b+<I#6yxMF4I9CQDg{8Mo!}%XKpbCIzG#@l&@T36#QyC;L#gq*0$L|(n`XsqO*#Fj+<YS~i|t0M'
    'QfgREn&F0+a0w2EooymmT_PBfxI>7lpZR(Rr@Cf**$%mJ8v1TOG05f+YoPGUyVlep^tRQ9u6^XT3HG*H#C;?%{`b{~aApw7^ANYV'
    'Jcqj&8>rt=j83FssFVFRjMTJM>$MVx+_v@O^I^?N-G@7nxLykdP}CkI0nCZn<w|rgTwW|zHXjDxDpw&5{bW5~)ZGUKVAH1(`czA~'
    'AO1d_ZZ((9O+#Q&J=?lIh(u`83|HywF4cYUrb^n1kA%LAYR(jEzJ<QxcR+q9fy;Wpc0d2^Y+c{@!{|-r4aFdj!=pFp@%N{rlb;XI'
    'j*j2zOPbT5w9|WCRb0GQF;99qnPI8}G=j!d`qE&KN<T96>pF1nMpd~2gp7b|tQ|TSxjcXwtXag^<ygFs4qb(Uht}Tys#7B|nr%Rs'
    '&MFW#obfkXeUMQb6g64TC7CwcOvzhapZYF(35ARSJIpu#c$2N`RntXMYMDBfv}}PHod`a|AK1<q&<MYDap*HbyOCuH(pq>CJieH{'
    '$w-)qlJ5gfVLG2u%b9)<5!gMrTJzxprMTlKT{3c+x9HKYUp3KyoV%UlK#rJoM3Dg8Z<CWONC>1XU`b(cdi0m0w`Xx=ex8j^-uRB0'
    '>X4s9GxQIU*8HDP$wrJ{7o!dRolciP+lS_~D&th$48Gr#y=ZsM5UrPFt|WR(elUlVYylD%%5(#g>s%ytlrXmEQy{mO^MNo!7&kJp'
    'xA7F-^KF8VQ6%}_-GJ9lx-dNa{%gt_#{X$ce()K4Ve8gB)A&}Rp<)OgL^jwE2NK5#TxjXZ=*98d7e}v0FVn+UfY<ck<R$#H?z`Ve'
    '03OT%up?cNw$ZB~b=%BG_IBMe#Q^LMoz0t~bFERiLnneI%IZkqH+;aZV;7(f57~2HNR+R(iiw}K#hW+4;fYcvi*;hSq@A|Q<<6Wf'
    'I$|#E)gkUyb5|UoIetFCP>F^WSL>uNlgmJJa8yfB=zL4<WS8vQoqJ&>!^Xe=ha~^&ktCdC0+sn=KcdwOEtW|ApmvnfOFF5rTk<1g'
    '_=+0G&Q;t@1F$I>vLBA@vi)XMJJz@nzU>8Ne_qtS4hyAv8f-Lns%#OojVW2x(+H-n=b9$Eu!EK6U6;{N8)cROY)*syu_Ed>B;gR3'
    'f&Lge0qX0p^H(#fR*e;@WMku2^H__W%T+eIBx47jYqLszXYQ$Sx`aL*8_ncPC0YTM%DpPSYNA1_!9yn8ZbJyn(9U<WZKYhSSv#E)'
    'Yq9B=6aPrhx~O9yA5~Ms#`l|38Wr8tK9br7BL&eeLj}>!{bFdBRxz}=QRU1naILbG>pCftHQM!p+TxH*o#bHE*)+Gpzg2?54YkzZ'
    'tJhq2&2{7mTtGU-@$T8r8_d0AMc#b`J9l#2=4c}e*HM=i1m+x69Zo>+u&oLlja;veL9Q+JkuC(R5*1F0Yw{2DjD*c%O<zQ(H<+3j'
    '<B+Xzc`AK?`8p`GE(K8m!IW=E-2+O1xVkBpll~%GuI|L@g`xcE=+&#yi?dTa-0O02H^A)rNatl!Q3LtI=wu{jbG-}R@skfR;fz)0'
    'm132mVID7jCqUrm!`DYI>HbE49M2c%eSSBLq+7Rl4nHrOu2t>XTmim$OZXUNUEp18d5?6crKgUkXlcOLOUp~4A8lXFZrfftM6jie'
    'pAn<=D>`har3HuCw7g`3w#gA!{4UU+3Z6RGFkqKLG&md1D<UXz(WjCP!fEZkljbX|QYA?4wYFYSV<$VE+t_(UjYIdL(<RV=I`W$S'
    '3f~U*YreO-o#g*esdE}#)H`afZZE8;ix)cpWlmMwBved(YM&k^A|cMlJHI+EN3%ZuCy)<vzY<3cS>DWWiVBj6>_f`rf&B~S1@x>I'
    'LU?19OThIZctxI4nN!b>2f?y6R5T>kb(c+!VY+WsVm;BrIvLxLoa=8}3H{hnX#%HbS>0*=6N`3JRDEC`no|GEa=LF$mA)<Qx|K0>'
    'x8&(|IXT;N5!1h0Y4Th0U#hH8el6@^s;HJku7Pa0+jFzGSIIQO58N16SVPy|MdyZWQz2s>9tmia)R>&`5&fw#`G|#j&nXp1ox{FD'
    'gV~)VCXw;25$9{T?kPR-ZN4PonS5UIY&k2iPJzPCPOWTv7(1jR3)U+*e)+)8Vr0<2QOJf4+lEB3O^7=+<10!%V!|5jbl!HO0Dgxs'
    'nx`u%zAH&X;+RVu%b7W-<Qv83)W*e~lXDIqmTFr~O-9?2WZNpnLg3yhz4nG2y@8z2JLSs`WXcxU>iox6h)U~Oc<yCC_R?hoz<AWy'
    'S-o1RMcNbnmyJ@c1kAIS((3KGhWTWxD2M=VXv)p5n=QGC72SM{sPgYX6~=k8!VJPY4Y|h%xM43usP-;(%H+U*dn@NOU*Zo}R>DO~'
    'Yn(_IX-PCI<^@Q-Fg^5!qNXd%zug#3GRq=4kz>YQ{X|7#d|q;aU}`d^!YDvyl+ZwFzXqN-FKHivvaILb17f~YJZyOC#p_nBu21f_'
    'n0M3PV6`4~>ZewxPx6W3{<F!wO#z&)ZO(2EVww+e<Qc77D+L1byqd&7yGnS&R`r0A#*YowyB~2gjR!3J-q}&4#mdhs2f$*U(7379'
    '(YD8;NxgPg4=_9I`N5EbFwT`p&n{Wp@Ho`no?Hf#>jgmMs#V><QyW^ZW_K<59CuT)S&DR0<5gD(W>i?`AJVi7je1TKG^slI_c+MZ'
    'YqMT~&`|uUZb#$AdF~|t{Oi%lC_Vh??1#n(R~)0ZvE%oLr=v#4Sye5rI8bC`=hw%_@4i2L@uPMDKCsV#I43VdW?f6=-OS6q90<8c'
    '5iOJkx996)CF@1Dtmzwo8}#?!aCr?|Rj%IAo30gbm89vU8fyp3dVNLtpRm~=n@m!8z`ttjwMwX3W1$e8nL(Q;fO`m8VInYBGy-?0'
    'a&7cVpDX!IjWU@a25T!}2J<N6XZV8&p+sIz8efhn1~++UGUT+5ye=^VPv25bZ}^BLut?A|Xy-31P!04i{X+h6flL2ae!?m!{rRv~'
    '0{%ukX?7FKMxQJo5A0jav+Mk`da^3|w=7r6B&x8&t=rKvVJ&F(NcEv@oEz1|2{^H0b&Q_KQ1m`)wj#?!<rt9Uovhla+2u~Cxlocz'
    'm0x8O#H_Iit%Kj#D$yc%f>>9+Y4m0%D?sTX-LmzhAi(+CEc)ZnGT>ETD^c9$4_r)ZFFky?A5Z{Rt2O4vZ~7c|;<SF?)Y>{N^La&z'
    '&j<CQgy?OZr0#oQHL5~<pPLx_3H@w-hV!+DzoIo_p%3Yo`V&Th_At1$_Jcnu2D!vP5`8hBjNTk#ZgN$WPDF;l99aX`_q0{~vpGqN'
    '3I#W+rJI(S$ij3}6+kVL^Po=c@?j%yIiLs?!+6ktuz#)mFM#J-&tZGJl<m<Nr?Jf-8yhjt1CyTzXiN2K8ctQPH(D^2WI3q)@)U+N'
    'gsV0Dt(wE_#_-?6AnvfWuU`K>J$!eRo*n-<dP^y3oT4Ola#`O^vsF`U16O_p^u}S9Hni0au^Vpo4A?<Gjz3c#teKWxTbF4TtR9y&'
    'FiDgjMCsy&LO-0yXv_L6suZ-{hvwv&d21E|NJ^}m;fnS7@IZ;1c(Gp&1NmTUWvTX(9t5<$4&_1aL<Z1i^ZK0sGvI{mPJ7Zc&}>u&'
    'xVG?dFZWpF9@4F;_s!z9tX<bPqGPPex|-!pQ1EIW^<UTvi$!Cw6l;{$RZ~9q)6*Z61CO>mG?WU9sxCyD^+EGOU=rGsbJY(Wn%m4r'
    'ep6euHQNY=db(OPVL*Y-GME+YoR>gaP_xCh^g5InSAC5!dykd>s0deSAhYF4W$R)efu@?*+lsxx0Bt0!7nRZ79KluwFlcPdK<G3u'
    'tFGB+fK(-%Or|A|I!AW=j6;sl&jp4<pAISs0}M*uSE)`lIkJ<kPa;|mo!9y~r)#OHC^4HcCb_F=3goN}O~5i{=@0Q*n#_#aJH2DP'
    'PriR7hvlFm@M?|u7zQ-gu7V|JT?B-@0?L1}?`1vPOv)OZ+%Qm?Ckncsi2TxUNW>$S(1-A^*mwCiv4+i1-_g%UqrZ+`rpNC_Cx>Up'
    'C+X?&PbV)%>B;C-Qy=V=UP*R|9RAPa@6)4~8^$ulmJ$p@+hxqN<FmupIPxhU(S0un&KX~HusaWacy=~=^X`mCKJdfqTFbpOJPRAz'
    ')}W%ytIcyV`u~0!p?cq^@ek{-tNUEW!SDq43J7~On#jQY%}25&aaxQ2qn&z4sYUGaDO;jh&G|6_GkoW1k4jbVLOE7$%WTezJb1tn'
    'cEsLBAZ6nU+Q>2~zlH~VUMUYggA@86XPpBfGLDpBvD9tH&hmm`W?HWJ7HLC65cM0j7x8fW!j+$R-}ol0HM4Q6$sa2TZXmO2S)v{p'
    'c3_UM)g}`&*$sICHzSDAlC|6|0b>XaV#PmOW=-@C4&{mPc30|fd0a8|j%^1uvZvtXhkg|BGbl+agw{UmB3}s2wSTFaSSxNLmt@az'
    '&gD0bAG?2SgPb<y&Y`J@rL^^`*YzS;DH^y2MEKxv`sKQey;oY(?7v`o=s&gYb^n#<UsEMudaqgYpIT%&G#%F7Z)+tQ_?Bip3pVH|'
    'fI4YOZ=j?x^Gr2$YhZDRt(DKh*-HDZAI9Dq!rl^Df{ZVPrCVPJMtL{G(d{0+aI}b&#7Zy^r*?LBDrJQ}W%*Sn%A>lKEcC3<|BDhZ'
    'SB1ndRY+5cNKG|WU|Z}(`6%AW{q@oC(HDQ%Ti46ItD@WkQV=cfRyS4o^rDnnLSk%}+&J1p*LLZJ^NglL=K7IupB2#b>W<9z>>y4q'
    'a8{)wubL2*FqI@7v*Jn_k>v^8r2w#{?u8lJ^$#MkJOFOC)%zXg-|=$qH1qB_Id|m8dX0W*7bUq8i{dLK<w=_MbRn4DfOT8gGS!aF'
    'iSY&=EUHD<^&f_<K@y6tld8wL@&UfQC=Ee%8(5ye(2C1L+V9C6g8j8)jz56q5De}3V)WW5pI~^eO3Sznv|ljJA-nZov(qoUa~zhu'
    'MxKi>wD!q^*P-bzOkdaD!Hr2+e#6j`{qDR*%5@mtOXP$5UU?5++GW84zO>zznqZ?E*r`1F;q2^P2RfdTSc~W^=^&#I=-YzF<HJpb'
    'j!S0fh^enz7K|s*bjoe}{-LDiR1oD-bhUQNqtDy5z_=*a)p`P4z}6WkSE07ApWRSI2!<UmBM{a<<VzIeSvMelqG%~Zk9*|m1Fl5Y'
    'w^h1|G$jxHv<p(%6oZ&CW3H6$=E&k;A{3xUzz<_6p>&6fN>pie1e{LviATDRKEY7;+V_d)i93i1`EdAqzkcX+AgP5DnSl3J`9mgZ'
    'UMe!;nCikss8i~bx0FB$Iaw#=m<AEm)&Z)pst~fs0V#Ms#{n@T*<DltLM>IuCUQ^6F`$)Cikh>c@~e*@31D~lGvKKC_E?;{)6=uV'
    'GY~*A*aGP5uX%}y1V24{^5^?r6DdUUaF4-9s!@HdUAB-*G<wa&Y)zi2EZZ^0a$;XR2D~KlN~MKvM+p)fgd<N-8gTFccZ5YH__z05'
    'r4x2D$I`17e`#bQ)hn+Wroj$8eLV2K_lg#qVgfmOXO<-XFdLCP`{3nlaVFX>4cX1aP_w}}6G!ddYtHH(C%z81#ZT3l=3az_)Vj`4'
    'y}_?=$IiOXdK4e!lr@MSl(L8cmk9jAZHPBS$hMctTGxp{J={js8AwbW0#PL5Ch1ZxZC@}<=Z2C^b~g3I%}4`Jf`bQqJ`IMEgH-^%'
    'a4iW(;tIV;p6<ty<d>E=Un(yyHyf++4y~*4`+TMPN0TaNWMmEUWLYfwQ>-M+WA4Exu|jJ!0(#6EAA2};c~L&_Qb+;%YcT<Y^L_<<'
    '*cz@Bm1ZX<0;dbEMwqV8c0G5QJ2zit%Ml`*utaDGq0))vRr8>*YdbS~h>sH(;J=>1y>x>G$Qzx4$1`{y4b#*}QcW&~LrwY61+ige'
    'Qi<n>QShv&JoLk;c~DfU>>;5}(|*NBK!srW&qfoSyL_ln0!=2L>=f7co<r&;|4tpC+uPWwrKk_)ZFegd45QF-)8!1Y0sm!Js3o?c'
    'TIA)%BniQ~K=AzI6;(Z5V5FxitiWOH(^+<15An()EQU+(;!%awt_Sont5F>7S6@3g($hiGzEPy<-Y!=PPq)QF<?0$0e%TJ5+uS)f'
    'sGgnM0`(3&h8{aWwlu}k<Vr%e>z*G;K_2g#Zykm*P!X#}OdXdfHHT8AZFVlEUJ!mfM@(KW@k_d3hx!1Q;?X9(24-7zNP0RXVz@D@'
    'URVpLK6t)=*=sQY7E?8Zr~y?$4yqX6<OqlD*&x}N=LrhVj>(tovLE^(O)?^B-ess-oYW;`a0f?l8=TI4=wK?}iwa+db`&uF-x29I'
    'Q9MV%V2{h&Fz8jHZxgD3v<!bK=9j93JMn!jypnfaY_2he|Ljh=7B^Ie1B*~_QvE)SjT7!`c|kcd^{4e+Id+R0J2#I6!dMqf(GBL?'
    'aw?p(wUCM@t?#8UgKsAlUd6Q27mwdmu`*V6R&@bghSPm76Iz@63WI?*u(4%sT{k;sLJKdNv@z0sCV?9^_#49_HD8&i4Dp7SmKaCx'
    'ZQVH<%=3@=m<!Y+_Vmd%yEVpMRURSLpTyW33lQ};H-!)Ryu3}?@`ourgEj%KHxwX|7~HgDD|YCOQ4*#%^7lJ*Qqd8laz@Ry9zexc'
    'G-Km@8~05<ejmzVq!3*(*N>fIPAsvYcSB<B>dVp3Z-09Iy4enpCt(B%rK9AGBdn|6EGc~H3JYzrf#U9{I8JMEnxQ3(-)p&+Wpk3T'
    'Kizv=yWFygxn(hLmhNSxuQ0kNgq_qKRa%Fpg=;_hR!cG8CehP<YbeEWi?$3EE5#(&38|Rg?-D@F(84J<*Fot=f0v|`@)eo9t!Z?!'
    'Q}%g)h=Z+n&6`QiUuKu^#`ANgK8_5=9w1y@1xRDQjygzdBqe>SDhO*k@@{ZG<Zls?ZKtV;Pg@gBV+Ei2KfQpSMyF$tb3&slakS^;'
    'lR_Y~%e~GD+iyUt;m)gieHZPsH=elS36zvR+1}QP&e-5u%r~PG?qmx}4MX9(O2yd>(l>ye7iIU!ery)s^Mchm2PnB1E?`*TnHKoJ'
    'YBodj8Y;|dERBU+l)b_aMLDTHG%7iL!Rp$p9L`}qh~BtZT}Nn$!lBSaK&oFW+_aXxp4~mS2gK&tEL+a`RM!!4Ve18>5Ien*i!){;'
    '2KfsaCK;BPBWf`4r9-onl$X*Cq0HyOdINIxG(wB>wZ)9^dE7xaWb1<(WoU(taomn7AZH?>Ijb^^=(sNG(s0m{PdynUOnh@tzp@pf'
    'cSGhcBD7X$Gl>1s6`4#3_hysm$yYUV@IsRY(cx`nXRqMVYDvir{W5(;EOV4i_-PKj*qm9aXgn)0>KQB5D(S!(j<7{M%@HOFTLLup'
    '$ydFgFuOYye6rt806k~@-#Dzsy#MeGyb2vTg@_=cn@B`!-$d@PG1tFJf>HIM93)PS!lrQbTg&;iT&H4mP%GN8hM_)e;p&B^XkqMM'
    'ru@MSs86|S+OpJiyy}1rb43984!-(oQ^th5BA;0YrJ3#2sC(?qw8}_s-!qM4n;A^zEkouE*93(B*T7C9l=?V2bUU_knBskx)y61F'
    'S4JKJo%V4d2QEqA3VU8)!==gsesp&9h7tfDzLp*;DXiVc<b9P?;fJqJ-q>m3xCSCeAP^n{sVgcFwVbO}R2O{bk=4<nyNm#M)0lOu'
    ')jie~9((Ly#Xp#F*DQ&d4vzJm>K$TjT3H&a1_l|byI-QKjzc3z2W57oD;uKvHd5tUAd6+xp4)W8ro;r7zFJE#b*6U&@bdDH(RT@s'
    '6LgIatt5PscABoO8r}>FH-WIsTy1Sj{^5<Eo@XDs`-6S_=O8vn(vO;VngOVtsA~t_Np7dslN#{jcp(1qR00?CL#NX8=x7ja;)R0W'
    'chbSJ*DT$?b~<@SLO<B|Dxa|o!}*-Z-&(`K$rQDRUoytLY)ndYNmtZf`7D^7laN>@M9O7Ulf+!JqbKG&yBddXimyDW{K>wPF0)`y'
    'BC`m42ener^<tcu?04;gs}BC<U;xRml~_5Ex;D(6R7jE=?FOS}kc;|XBobQ5I^h1uRx3%<aq-9(Zt;F4em_{}QH|4eg<r~1q&`8n'
    'KwDO~9R)^qJ#Lg_Ni6d(2oUJCwgX6fS)$ug?$N9J>g}^vhL${Nt-`Uv<a426TFTnCj3-INdLn1(ykT)<Wfbc*hq3V08&Tmaah*<q'
    '*wn9~+ajT=0j-mcJ5|r}e9^^i-5(qX`QI#~_MEDZb}miC&UBiIj$FHq2NN<LPp4dWXI5MnSH%otOGL?`V@)K?J{pmy5&r^&K6;5Q'
    'r^T{XO0(IW4n%RNo$^{$sRpNOjG(9$6+9z}^IcWVMx;frmR2_{ovPNOTk#}yGSS2Fq8Hs>iz~HjT75ur$A@|TjAvC%v+-;k1eCsO'
    'hSxC++$m(cM4QQkLqgr<1PpmRij(R}QtDbUnra5&(g-jY%)t8x4%IXM*#U`}ok22nG@zTwlN__XgKLBu;<}h+WuSDaU#I|;-+{8x'
    'LkiX6;=v!>>U)kW`MtY*X-qTqn}%Y!0$--IXfio#X|x;^eMtS0MJm(x8y(0T%x`RMh8pxd@X^bbEwZ*rB3_ZuksEL7kVhhN{M^Y&'
    '$Zv?F)Jd*4M%b!Ywze%cN&GjK##OqIjEJ9YKVe5ctXMc~Pf@wC(E7ttRZ52LWJ9q}_G@mKgJ6+Vl?O}CQFRKxPU4QGDXr9!n+v29'
    'DI-0JX{&!Xo63Gm2u!fThg;H8hHTWi+z>{)L&?rwAZ4YgnN`#&mEeveCpwZc7}hoC?_Gf;w_aFw3@@!~BdX83@-P>l?`LGv?FQiO'
    'V}DBu-i;Xe;IzDo^nXrnTqMvY87!l-aiR>IWy{yUOQjp+v%R+JFT}Jj?qJM(fqw+Em$r3A(N^+XHP>;@Yrqhw_9e89Oe`RVjbE~b'
    'bUY`IJoJ!3{)tIjQIbe>=iUX4JhgQAl|Eb;-_OeHN`HnNhDt1UP%khCh58<UJzO`7-=Xor)YoC`*TeXf%;w93d3U!uM76{(tAF&U'
    'aD@A67N-7=9(_aQUErq!%*y6*>7KE`w|RK-3R45BF8v&dNMNcPssx)Xx;9<n4AIT>xw}{Mb@LLdnd-n|rfu2<ru}S&$Ki9`7gIez'
    'S`9=PXXOJ<=;-rVOXSGy{1vzQr5vL$DmF=d3-X1(6hw*GMu*+=b3F8Z;k^!K0CDEnf@SgUr#u9CPAj@OU9w}a5i>ebG9p7lm^2dY'
    'K-lW{#Uh<$>$07^^jg^e@a!-JuBQ#ydUe{z*)rEyLwR}W(Sp-H1oYdYE!ftYuGkiswU6W~x}3`r!O*-l;<gR85%=)LkKtrS8}`TW'
    'A{(@yZTs4`aM8#FkjR~|r%j?nJg}=*v*yXt*YSos!oAUYJ0;*~%_QHV1oF2p#P8tpc`i<zXpm#JcQIEZ@6lY0bhIt|yVe}G`1v)<'
    'v06gFPU-4fdp{_ReXu^LkuQ^WMlV>|SR+!hA#iDDS<99B<lbv(^O-QSswRFmz_yeE2w#<2+h)1X(t}_j0sU5q-(QGbg^Zasu{9F$'
    'THaRgO=x=laWN~##Y((Bs%6y2OvB{LEuI)3Dg-M!E;hA!u<IXFX^<Rzt!#3l1jLH#Vg#x_)M%fcO_bBFlw;@rh0KN4Ao77hy}p_k'
    'sPAJ}WE{1(gWBk_p*D(TbnNtNvFNsRRLvUc&cY!hxJXqtnmZ2I1*+TI5`z&c;OF>=QE5zD9a95!M597hqlppTVQjUiZwJvaN5PW$'
    'C=LyY3FvU1fW3eilGwmHp6CyG2RCsso6#`!jdJF|)S7<90SUjTmKzA#4!RM%O;WW8rIhu`qS9}xC@MD~Ut@l?(-lf5ZKDDTV>8h='
    'em3D`$bP&Ud0yzaOj&*4OE`kUiPlDZB2+Vb9if`E7LFKpoOp2;&kc$T7W=9G7)5!E?ygmN^;x`GuO=W*b&&~?&Ela_`JByig6M#('
    '0-lhtj{*k0U@IXGWGi#n{j#!R4-J|U;l&CYn*C4-YX}dug~ZBKf|D@Q!VMZWD<|S(WwN$E$oh#J?aAO0Z&sVS>06p*0a-QLmhLHN'
    '%Q*#ZhKV@E)(8h^B?4ksJ>^~}dg{HONuRh!<rZtoQRo<N{$+KrTGVX8R7AnbS;3Yz6@GY~te`^gfy%ig@e8Phs!F!8Ky<s%G2r~^'
    '%Bo;zY~R)C{Cuv}#fXx4-sgDKH>|5#!=~Y?&M$kM4OFebRy#M7u$ly0;?@^pavNrGRlmbEmf^ZFUv%GU6s#j<y>3x+SvIARfMEvM'
    'QLF$u*HvRWMiIM;8a;EWSw2z*nTCZ%Z9p({k_}b^mVlXML+PSs+$eL9X6Ye~lcSl|5|m|d+NmCw5$>%0#jgF9;$ZS=ue{Z;CA!h2'
    '{n`AgxL#N5TKoi0&yL^uO1oGXq9yP(*{UIoHmhLmSo2Hj_9p7AScQCj#BwQ-rN?16O_gAszRr$e2~hT<znqOu-cW%8@c_Aabg*AH'
    '#o;zW$D`vl{O@eWk{$e`y+SU#+a~<u2!Av#QmzqZ%GE$WkIqu>or}IT{WVnornX`?6^=cIrigBL{dfcA)2xR+sq4~WJ;H=gr9f;_'
    '!C;C+*ELeTYdI;4Wqw;!ly@gU{Z#KANuL^w(pypG1CygWKqwKUGra$FFI~IUA)EyF-<xbI=o#ofgl1X{8O_cv1lL|*P<<-iDc{~E'
    'JF`v!$@C=fmO+`&>{@j=iC;`Ts5?~5lLA@DW^7rZw>7JPBc2r*c@h=CM_)Yp>Fvqr^!RniULHs;?84nm&WB3(s>XnjKBXY5&;xsy'
    '+<eES(P3ahDJ+$Tx_>iZWCnygqau4X`FHE+mONWdDE|{C=&Nsvg=Uh)FG-d1h&jbge3R9fWG}{(7gu$>gd<VS<7FN*S&xz0#a5aY'
    'POP_MhQIbaek$8kDD~MQt83GO8UMG{>J^4;HItO7)>6(er_c?Pi))YagHT|O%DPoeqYOjHqMHoOawfSM+wEh(OcXtENQySgW?1#S'
    'sO3V=C(k*p7k}#6lRsmED~@i!R<q)L{-L0BZQNWbF*uoejN_WDSs-R{A}>4Xmn0&?v|fgMUX*7ihi^}hMsLs1{raU&-;lWJyyCAw'
    'viWNN3H<LV{O=jYM^Jl7n|+#mZA7;W^MbCHcj+XbWp`c4Hde=yCy9$cI`Z3pB35DsxF`MZp6o|;gmKW-6vREz%pn_tk{gZ44v%GS'
    'm3ah+PK#Ca%P%zeFTc1h$5XX<VdGlXj7lOk+3yl(c|$p!CgTLnBw^GZtjhuuM05vV#Rt7F#YOeWmtU&U+#}A5zziz*$Kxma-*SdG'
    'D@hoGl9T(U93s}GMzLu35);iOA~3Rh6Tp;wx}v)Tkg?Cu1J;MU2ulh=rg%m6eWlETeMup#JT4v3X)oJkm(Y{*{Y$q@HvmG-TE>x@'
    'ZF!IKi6}p1S~;~eSj1Yll&LSN0JIzy=cXdKWHTf#EGxzH9B_iq4od!gLJtB3h<F7jB8GDWC#A+M$Z7civ0r|HaS?Y!NsR3{>t3yn'
    'BF9|krSAXBF9O~aU=9esf=lI>U*tmw>YJ)wDU89FI*_n_PB>i5fki4%X-U%*57f*|45a0vw(}jfdW);OaZz+Tu=}03v&SH-_d1U?'
    '@ER^kQs0_0!AF{#BhI8#Ogg<JF_7<|f{SWCG#CpkQ;wUdX5Mk7s?Faa2DsA$gy~3lWGZ!*U>WjP4s!{`k3W9$U4n5jf_1`eg}jWP'
    '^mJqfE}i}P06sNbExJ1C)YQ)yHl!`p*rs-rS;<@-s~ak##!m+-16jBCoMWuea-h<~!m<h#JDDVupsBOCxvMFE43*JPfvp|8gnCsE'
    'rW4BPRMl2)C-`xkp1eGM`}*(yq`%)DzdC;X`uMNv*W2%3AHVpq7k8Fd9ZL8F-_NtTogbu}R#@L*iu=*!*8`kLS#^7|0(><%O^;4b'
    'Mt|vIhe5rfRK;vcR8Q6*R^d>vz3^wZryW-8E`OwAR!+aV_%;7FIr#d^gZ(GZ=wAR6$u&zXNEk4-qa{z9w#FXy@qykp;$jJCtcz5^'
    'IN67!YbB6o1i>UvDX`|EvVGjSxB%qV^+0yqn7^Kwjd=m&@{Io+{q4nTcei5B%>_rz-6dHTmn6Y#fX~(b%+~b{;1})NT{&*-n<%TP'
    'a)+LkWF~H6&C8>c(TlU=lfPSGYI^AD#0xBgH>B3(Hw@jYVu|=~qH;Md0}T}T5J*5Fm7L+{cL#At#pMX=`R?dt$Ecv`Fm?8jS=_@o'
    'OtK|+g8p5!Uwrze(&H0+;$C$j-UPYHF8o~sTMU$^7j@v$K0mk|@B^PdvdVk^@()SpzlauPYMueq>)<yz57V&o*qQlVz4ty}micUt'
    'nTEY9V761Fug<iPBrJfYb)Y|g`ryy*t!gE2p-eC-XCUvMcNR5Fu)pZUXzxKt!><Y+&1gbN=Q75RumGdf8DHs7wg$8co7JtE#fY_L'
    'DOH0w*<3&n+KF3uE}?_Twg}bdJpFLglXkO(&%!1Gtxz$mPJn6$M&apG1d&<_cG|y0W`zGDMnqovL8O!Jmz+Z1#yGaGX^Ep_q^Zc`'
    't88qcUV|na8&Bwv=;iHShOR$Gw{K-BLG#fLF|D#j0MiaZngSt<Kv4AR^I-gy%uj*5L-AJ)ICXwg!0Nu4cW`yVC{>2oaF_8hDoMqp'
    'a<_iVIwd-Z*muq+wYuY50EO$A(wXo*V%<50i+G+Tmck0DyoKhO@JggXLB6cBO-InzbLih5bXYgVgJ6Y?4|pzs8sl{AcbKUJa1dEn'
    '{XXt!UkHBfY@zx}<67o<pLepwqH_roF0<RB58P`F$Fx6Nf9%ubWoGA{WqysgfGvw`q95PR=>n(cl8g_PV*PJE>L&AiUV+FtFRrlF'
    '(<guW`Wy91v#c~odQB~!eD!tQnHC?}MM*6L2y2kLpk;7Pm-7zO+f*kg>s<EG-_vk<^x;jd`RZ+91Gjgym_%+QHplR^>E6Zhme;B@'
    'NJ_F63}{`&2j3>)M!<{#-p2sptX?n4m*P4rRS9}kbC5;Y4HHnPbu~lg-oQMqXVnTWuKk`pn|+wg_8#AcXKWY>>1=N?cMbvQ7H*Dd'
    '0Wv4Zc7T(YD2-s~u@!k7X!R{$O!zO^d7{^xw@8s|e%lXre@e_A5Dz?4sOu+>7j>eXnKEMqql`g1F4v2c7~&MJdYEmJG+t19goi3l'
    '70G+yq~~j$`5!j$Hg`T|d!wEsW3%FLPi3@*ac97R^%}0Lc4HAhowk_bv}MHJcgZu0(&#4Q^cKc1r=o2~7qor0f8UAWJL1;|i~x*}'
    'gJT%G6oyzz8oS1r?M&7+U>NXKFPO_hqK*Ppe%mJ<D7^Y%bokO{wKRi88)VNWw%G-l5%yLRbthEqyt7=FeT(i}#Qqv(=(w|k;@E9v'
    '4I%Zbp@qZcNT_eJ6)gR->M!%f42wcmSD4$iZbGZRsXjEe1~^_$nuFR3T<xXLiBtEzj<o9RVIyIlukKcPjSyBd4S|*#DcBAp{)(r4'
    'SIX-FyEAf<_M80Uq_{@Qp1#|u&<oW9`j^Q5z(^ERE^qfc$p0eohXj5O0(g+f&s|)h-#lv-``vCV_#4T-b;0B%mUz2j2f2|Z>}pnx'
    '-wzX8@;}&r_RUv+`nor~8E|Yvmm2w|+igp?mOIIBWAm#hE9)0>7S_)>68yBRVQ0H+=ac^W2X@y#sJH&5JI5Uj7LOtby559PQ-zfh'
    'PGm8^jwb-<d>IqlmzMblhX)l8VZu+uFmfMcbj80OcLtruJP!PcS&%xmHyJxC>l;gX0y`hZJ1UVm$P>Dp628*-QO^kdJR>9H(_Yw|'
    'F>bMn<Vg}%)Yxa<+@v#XYvS`k60{4rF@vh05_h!Uj2^)D@At8j^hn}Zt-RWJ7xMC!szKFV+ya%#c4!E?vh{XA&@PEeqR}HSCl2LR'
    'nZ!WI1bV3l?OdKi|I6oEcrfkYV$JZ<_o?R=!j>fV5Zs7vDDfoI`R~xmXwgu#U0b@=YzYTH(F@+|ssZ}c6wpT{w1;szjimSu!o~ys'
    '77g0(qd*gh4(+F~p=gb0N^)OBhdR&-K`wsfq9>;^7MMv8d6fvcp=g{fmjzZbB{Q9H(w$n3CIP9m;ZgVhJlWrme*8Ylp;_-a!|P^U'
    'PL}kcDV7SMl0Z}fxsFh~L{^`b8V;`NWmanYkENO*8ZA!LD4j1Yez}gal}c$jFy88pl|k`u|6Z@>a2W2A6+opU1k~aT$<3YkKoGqU'
    '3JSS&4a6`r_F#T`J3C!W>f{^{9XV(6dM5{YnBOJO8hKP`1IGgYLNh4-f_YEY$eZGor6eCcc{TPI(T^?wmDQb0*J%9EqEuaG3*d%U'
    'L)unFqiQt7&yh-~0kII*kNpEB&(vJTg!f84BcJrjPS}(!X9XsiFLRY(RJGkjxM~q0nX7{y>(Y}T70k3C={9|=Cn}Oupvi%5)FzF_'
    'owAC;qNoBIf!M65qm$^NV+m196qF>#3zy9WdaB6g^ANS<g1Rof3=U!lr!zI3QHHCEdbhchmszz+Mc*b017p*`IyGVL0MS`dE@eiI'
    'nJWPL#WjQ3*2W54VGcO^qpQ<3`VZo4H!3OijKW1ST@H-v2wveG+lr`iW3yOh6iH@8#cCw}^-oi=L3n$vbYqvUZp;#J%-r;(v}){D'
    '>#3B+N<Fp(m4+Cn8+qEL56cP&u(ee6!Hzd+ZC>qMiibjr3~g<`8J3+{Iwk>QLsS0v;G6vocH?Ha&Sp!pGhth+&CwXHb4@VQjD>nO'
    'E(Fr*F*0^Sj(Ywozr|GHn@5vx`onp7s19OILIsWc!Q@k3^c&o>>wJ@~TU-M5*$U^!x{cj>CXEcPG-!;>b}z6_o%NQKI#)Rr#3Jh2'
    '*_I)VAxC=oP2jV~xq>}>?=Z8m61@?B&&hKj_E076c2Jz4=ky0X5}j{ssekdYI!!U0CHxHsd3lGf9i5n%uFIk2zM$PGZ4E$UEh?1Q'
    '<y$rQmE(X|y?`4>McQ<#sHQ2u0S7}-MkNv^TPQ5eneP@66Il(vLZ=Wz?a3f$;|(`H7Y7NVYwQmUhY|!9Ys1vOv!4l;(=6FF>aMBn'
    'bf&OgRjI5tFHu(nQ@}X@3ptBBDlr7Nh~OexSw{$vUCl5w&gHPJ&X#>kaHoOg8s8x_?=nmi7meb;hvc?$ljC$d?|#}yyJ97{ZXS-U'
    'ek`Bww9U3;shxboa0W2bw~QzDcD%4LTXtnqurnult_Vl$$f%p(t~v<hX%@y)BF|<h@xaAQ71zC!FfS%C9_5${dhd2Hde7%U@d5T{'
    'uKklZS$v^fMxqwhNRT|J0RAR^`sBWYQ?%KpJ?(5@lm*7$fIrJ}L6YG2DdDK1S4l#8Sb1iwRTk}1FIjp+o{&I;t>_PW-}w(_6o(yH'
    '8iUSOUa0#+c~~jJ<<HW5gQPzE2B*YWtkd@ea00fqtP{iII{7A6rm`zGll4NMhUqQx#&<bLDsjHd&pMXe#7}?}bLlevdA@(C&K^$F'
    'J&1lgX2pTl?XBjEJ*Cz*leCB)b_&C1E15O>yOkWOW7;wc9v%Z9_T)hNGveS@-W~CP-)_8hIMleIVAE$(7M0A!MKa;_#FpWcd-ysa'
    '!$sSoO$*%!+Y)@%UPtjV`4D^41`1-43;~kQ=Rb4~J=ZvdW3~wfJHTC)0HIO*J)pBM3v(L!pvQ*0LEk|!JriHVV>?a0E3m|@<5GGD'
    'PHMm%)@YhqrwJOVwaZf?eR#`i9gXzVN*<Mhh~26BT)tIiJ+qBpq=>^?hJl3lftiFTM0M6kT8_5Q7<i~bP}Rw*>5j}t>3nM+%5x0G'
    '53lO^t@TdPHF@=ryX&^4Sy1Rh+Y!p0ot{-@2xS8#_Ay@<0O+Mt@{PDEM<r_^2082IsGNln9(Nobtmiw{h4uXUVAGA`%_OlV<%mdr'
    'q+?LQuTn;71wV__T1T&)q`9G1?K83VSWgLWWHr5Ni2R!5uVr22cFx2^h_)2ccC`B_26e0`E@azD2GVkmx=RHHemrg9T<LeAo4Zvv'
    'Z|3c|T>l}l{HrCj0x(K{E%vIbD2)NZiQVFxpnBZ-_xHtYCW_!-c8`}@`P`n|LwvDS?r~~{fb+cMI<Y9Lywab+dafMXqxOk;ds6-)'
    '*t*a517Y;raiWPAgcFvO{6B~o4|LQIAxUB*iN7pMeR80#Ck(!BIM3UY(nnV$r{@?o#nDZgi`%G$vd^QdZ`mMohWQ5xHnAm7D;Eoj'
    'I3^SAt@*`+6_l^3bNKz~=q=1qb!5WI(SkkK<ft?aA<4+sY3wWrN_2^*;VR^QP&ZV3>mKI7K@NfV0mt??9@!1YRe%<Z41!H*C_UZi'
    'se^C!du<5wxxpy^lZe(_1o<xWGp#P#1s$8m)W)ifr_|x`Q{8PhZeK;HVw4rdO9Hg+EbY~7R*h9LKP+-qMI=!n<w9RIWq)(xqO`g2'
    ';X;E+liER@2h0HdU&W9sjH0Ymvxn?95&o2LR$>9M`6|W1!{<<C)aKRD^n$Pg1UJ(W*OH^YWV0(f_;0v;ou(ibZx^%#V3wl52mLyL'
    'digGE$Hs#uV<%&CdQtMTvY@Uid9h|R0Bg-}QrA%Ah;Yea1~g?UP3+m62XVWYq#FJfQILV6EX~@S?Lvi3#7ElAfZPs->}P;BK=L!V'
    '^Sum|dx7g%z=q{ac@x+lFy=<flYpXiDRNO{IeaLa_#vxx9Ooc9W#0gvQ8ib73AU?)ijo$s4tW@IeM~F4lTPv`E2%k!*K9U~X)8!!'
    'X+?W{)-A!~LIr=r>7K#3XjnJeo2UynLBSOr3C8G9!ET0DT*Ys9f6z%HthaNv?C4ZQl!puXIPtq__mNPNATP2z@2N=0ti0=f<SR{1'
    'Z_n4f;paXQLptY%is!7BD!Y@?@Wtm&N*BeLBr1Z`>JemGoV;u*+t~Ts_+aQ|lLHu!L@Y7PS{)`<!%{(HJ3v)^@Y3OA)l-`eG3eC`'
    'k-W`>hUQO|a85OLpuNh98O(lzU_dLPT2t2WmmU>F9B@|p2Y;o?eNu0(1F6U76Ot<EGcqfREVq}8UeD@aShp%u!H6+l=MZ{M8vi{{'
    'Q`7ms#A_2*Yw<v?xn>jJT~_Ig^NjIes@f1oyTK`%10+*8|2Vl+X{3~)r|A;7D-X^a6lNZcrEVh|=~ybORg)L`jr_**f6Xobc`ll}'
    'T=QP)u8@=EZUW2}Plf+ES%z(iK~cs<`Q4=&V{Wv?8q1`(t5g$j<o|VA2?d5?gJ<mj6g5EF??8f!%Tb~$EgJncilKxbjGfV(<RVeI'
    'a0Z9V>ou|z@9@{M+k3tkWRppn$zvcY9QGKGZ>nO9H(`hT1jW#WE+u_KtVt_G(}TbA^0v=PZ}u5pFZ$JV+F`k+qqN$6HvPv!g(UGD'
    '1%8kaV?3eEGjxCR=h-(gglOI2U6vSP%scyz!WNsoFj(V39gN4<=62S+H?~t+vCuodYy&UYRvVlixv2Ls){4Ii0PQ`;y0Xb)KzokO'
    'YbPIoik!w{YS9+ul%JRgQS3U<KV$l71&s3RvCv9%8W&s%VMWi?=TTn`Tt_Bjn&G_P=-L+>sYgW~nt?sriT!n+d6MYq4poqXzit(-'
    'z?0IU1MUSK9NMgZX#3u~tJ`55_qc>INV-FA6hGsQp%I9MytT%Kf`7A1z)tpCYOh;*mfT(7W>bryuRO<hQa>rtNU3A6_O=C)`6b3G'
    'I5(d<DeX?0c7~Lg+WrWjm`YyV8CsV{%B=v;U;Hq7@#E-a`r`QYYsyoRp8jx%V)f92jx(+kCg#BC-d}P)?xN5IGu$vl9GW@yh5M71'
    '>6gHxijF`wbnVB}0tLIbuvFT(0HnmZ9S&aCYuuIec8QOQ+LAd~WpM5Piu&lXm=djNU@gCJ?DmaTTpmT*u${Kih9B#3rj0Pi24X9R'
    '1$rbuVi32q-)*nA!@1jL-`;%qEIz}T1`&?r6XM`dTamp_lS;si%4|a3hp-Dv2Wq|hz)9Wd)ag=6%nkL&*@DuR!`XZOdqr*P8SD_c'
    'x!cr~mwn)1*$$i{YMR7$637|2X~Lvs3r(@29`rXl_s@M2z_W42YdPuT872ix<n+Fp;n7tnjWJAcF%=;HFhBn4_21LOcSq^j@sFdo'
    'sBlrIULr)(RrNkEVT4bHA?Ib84Y}`yGfUTr>r1?u4G0xBmSH@^@5-L^JCChf<Z%an<HTHPB`uNG_S#2pBu}?D6m#j8fdBihl8bPK'
    'VnG^7U%!Y>bVfNRwH;0i^DCNgARVU#2ezV|h_yeKq{~AEp$<1OoNygI-AC0Yv1eEdGUCeZUg-y#=&rf*(9s1`4Rkw2IqftnCc5`F'
    'bAUtsg2}WO2#I<OQ|((}Q{jZKl77#IH44`A9F{y`%feMPxg*5#A+Pcr+MCrHZeSM`U4z^cs49h0z0zT>R{4CfYRp5jNd~L9?Or{^'
    'WO8)ROQXUFmi5?>pEJ{mK$We^O909Ndz8_q?JJZslT^=WvSlILQ;<X-s`YHb(at6@E9%{0&j$c#I|FFk_8}Ga$AMU1ef;Pq1s%d1'
    'DiD`>bsSc91NU!qmFED=#bSmxY)c_Jfl$J`bKXC=G}$*j^HsAiWok-fs{zGPv8uf481U`MJA0IzPdbV+$myFTuxl-q(<m7wecexH'
    '!8#uy%rE!`d&St^xooTMXCH~j$-#5U7228@RZTIriCg<rC4Z<WU;{oco>K<3_iP2*j+Gy_1K3z$Vgf~$J@!nV!eSeFxTnR(#3uT1'
    'hgd)R|F-}2r1NiTfSz02pmsF(E%*an_%j>sG|fYDOAd0c*Hier+Zou!$>COKH5B8L1)s#wK>U}#LF9`kDx|LZBbEO8H;sXL17XNJ'
    ')RXqwDvWzWBr+BD(6Wb9$s+>sPO`8N!{kz7W$VD1g-cuR1mZ1V&OYn}V!0RyN(kwc^GYZDpTX7F&m{Gt0->oWLe0a%vTp3i$KHKq'
    'D{Y?a2QuB+@!s1@UKtZRbB2S^jjB`e!3Skymx<cpb}G=Ml4RSaQ0*EQ(zR6Kn<$lUresCEgqb}kxGWUZ#&vyK?r5Q_Dps&_IsBcL'
    '%T_*zU$Qi%8-O9sFm8VE9*ghoSC>D(X1eI$cQ$BcguAm64mhPvnp&%X&UhHCs<^Al%}N!*DsQh;I0r@f9w@Fh>N9-W8uqj;@femt'
    'lWPZIu8;O0aIJ!EWODEq833}4LQZ&~ziLNl+F|n=8u?+!r^?=^&;J-135F8ZwcC)6mPV^9Eq#vv(K;WRz>fz^8z!qHb(m?IqBMs>'
    'I~!U2st8K&ihGXiY`sfGgcsyg^5G_@r1%*n`SyKcNY)c#0?-qG6huAkY$kOGQmN*arb?|xC9I?vTB%DUPze+DV>&KZGySWo^`FaJ'
    '|B3bE3e%{*Gp&$uLnViKV9F;1>mn%KBY9-;i^KAci><vm{^{-6;rFjc>CeZne|j?_etL8&MdnrInfr?ptMDAXJ$#+MIy`zkdKqfY'
    '8APb{>EWwUdi3_?=x^zdqrbyztfVIzmF2~w^TYmsW&L0G`+pv!{maKx+C~}FQoN;8xvh~{-3}>R%6Yw7UiPB?cT`vef5o_rOOv*n'
    '^2$Mbs;=^E*htR%$uD4|JT@*K4ec^9Yyg3Q&YxU5$$6U<%LGYU2YA{(z`YZFtb2E1tKn7ygznkp@C3sZ7c=yL5L?9~hg2dO0kv8$'
    'X8AdV@#3>fo$W~+r;<p9Q#H^uJSfk)lFZdf@SE$!JFR69XkFr(&4RlaphKjY{s2)<PXzt*;F(`M+pNh399f0=r|pa&$yge0DRx8%'
    '7SNG={X-ozhnk@Bnh&)Ja)kLSQ?yJ=SKh(ZDpw~{I4%G(m^c+^r6vy0usJ#MkfR%df<Ib_7nk4o(#=h;M{ll^s}5ozAh-z4qR8lt'
    'llkNWdT4`Q>QMEZZIXQ!gjMAvU|m*Z!^NXddRF(zC;l7_Y6=e^fI0&1&b?jHX{xK|rR*_fR_O3Z;bFyztA&*D00w|+|JyKRYEa};'
    'C+-aXQ59Up6Q1<$O<{~SXiL~MXG}_!8$ktJ)v}o29U>Lbhj?)5nBoC-e4_s<w-c-65!k={g2ieF<N4&5U!-;ntE7a(sX6VFm8i*-'
    'uvo6kS`C1DYZ!rwUGM|wez$-nuHZ2M5e2t=iK2M4s+`Ztk*h1@{ozzBvD^wN7%+7|w!4ENWW9I}Nr9#K%uEW7<d_<(pw$(%a_WU&'
    'T$uL-t<2KSqO9wh5h5`okcVo{9-Rv;ii<g!1~wGc=mpl{Q~QBGRS9}$C#jw9C&-vpsN;yxQx((wR~nAaWfu6X*>{(ONB^`b7cb$='
    '6f5nhJp>@nL0ZSuDe&aeJ^UuHva@%LdrR}DhsdQne2YazERj#S-;&VRJQ+re5omIIMMdD5riuZWPVFz@Bl(V7?<Ra~2+wvuFr+*+'
    'Cru4!V<o%xhOu|>If%3Uq^r6Z0R*!!2o9NCdsq(;XQnE^@${&6pUWg^mtZn_kpuaVc)mEAWmoyka00|Yx%j5I0aXy#u9L@kN)6l6'
    'hBvG#h}fqYz0JzIuGa)F5w+pYrDE6J2!^5HokGjFw|t+q{(&>-RZ~$z)Ve%kxS()aXH&Q>;O~zqz2dnOPBowf{~c~wGBrg5FuZk{'
    'T`LvEPHP0}3{#8LQVB+SxisNn^od6L!}5OHD$y{&cEc{Gyf=r&EQ;R@>O6nn-M0flh(EYD!I3jgZzmnBbzr)msLmJJGFxGJWragj'
    'KWfS8j^P}k%tblNSLB`tj}oVfCEn<25Kmdb^Pwb{Fs`LVvKL;<(V+$NX>mn~#rlep^`Xb)6fd=|#TNr$gyuTjF@aDm$g|mk`1tzx'
    'r<dQ4-oE$&cKqkjTdb3ko{V0dj81<@vAT{m4bltZ)IMt<whMd12|ikLRCf`5C``I}gth?$i5vZ!b!H7(T5ydBt`VgHRIv(rx{Nrg'
    'fVTN)kCS@>-(&#gC{Rg69!#-^AhJ%z8Ouw8(dch3IyDbKFZx5$SlnkUu#t&D&%EL0Yb7q`sdIsxa0z*p$(LHjJW~sUB^Woo&f)Wn'
    '$dsEGt^Z8x)!}ye2U7r?YC2+JRe9uLf{OMn>a@O_!vTKZ-N*rOLRQA;B^wgocil3|s+zr>l?R3X!KGP6zo7z%W#}F0rIq|pmdf3M'
    'Sn?kMYRNBbv3iWRH6e|4dlEzoou*AH%&n?9rsl?kuAD%K(pJOiTbBp}(l@TrO7@--HIP!VPlno}tR}f;$xmo5b+peMn#>`e>?sEB'
    'K+NVDV_}Vq4F@YR?}BC#{4fvqgonXbxB_xWQgPmB$5@s*JZ3&wzICUpe*t#cJ%;-H5=WrU>|-DGU%_;hvV7!O+6DCcq2ZfGliklf'
    'pu6?^?e|UZ{_k-VV3UuIM*-`<%<I4o0R+f0Vsk=pZvs6@+r4T2Xebl21Q&C{4oHD$@K8B#p2m~L>^H&Gg=>S{I2Sv6p|G|`-Y=E?'
    '-zG_d)Tz3#rbG?}&nJUVoYH-PDc$b}pR_j#`S>`py!eq#U<@w{2eUT7(8QXv$V(9Eu&`>ECe&+!lUNGN$|JXZ(yY0zS9(q#x#UG~'
    '>rc+|?uj!AZHAt@$qV98G=4wyoqS3YEw=HKz3qD?&nZbYZxTbM(P9O1J<7b@<}1l(ZFz>N#MVAa+t~BJ1Dmzy0DhQBYq!@%PMXD{'
    'KA)ug^tMStj!#3AHDNrVJ6>HbLcCe#P^!c_wS_cMtU1rTi`}}?Ewyb>{Bu4L8}+tEJEO-9_P1vfN0#zYC82(|M7MZYjf}+VIPz8+'
    'L@!_?P*Y`8)xBteC1yl13)kT|E2%R1O>Q!rOK_`><;4s2XKi^|W_NY;mJA#<@CUH-R4o=0T};snk!y;n(WW3YuN>A5F7YZl?!LWP'
    '@9$qd=~2cu%x4Z~HTqCY0K*)0?eC`~#a$HdMlQ|7wIgE=x=gG0cA`jPFk}9YroSQCg_|2Dit$7kKj>q)G*rE(cy`*G)E_cdT5xW1'
    'hg!R*Nb#T?;Z6J}PH+=z>O`jhwIBv04{+5t`D_xSyBuY7F#OIqqk7}0P_RcTfpJvqp84z``VsXwIz(Lf*gm@80W96=Kexxj4C!|g'
    '$S8UCQK=|FnAMcx$bk{VTt)yRGe7jVBM2_s7<u^?1+v@4x6NcxQW`I_`X-v>SIeRvxc8$8Z>I=fz@qC}bp=Q_uz2S$o0lKv?NMFH'
    'Jd0#HuyG;3C^9t;mh;sz&%1h*I4Z77>_#qdwL)0a-&&Ihc*-(~n2&#p8&KlT9$9@j7zyEtg(x~zNwI_ht<m=!Q=MJ!c;3<)-#AUJ'
    'vE^9yn&ULze8HHd1Kd@bI9;`dvf*Xu-f5K9K$2?YYHISViEM@uy^4wT!RicxaIop38K4XV%ET7EV`O8WBx2t!jJIOR)OS<sez1LN'
    '$;_ln73f=J*hpiI$sn}N&9`|qv5h+fHRjtD%bSI8O3!Kls%GCZ8Mb^Rk$lXx&e6-z{JGbb=~JWMY4+in0Gas*=k`k?JN$JQfCpxz'
    'hdVcWhm7#2_xasW)O0FexBM(hrOuZGitWx(O|K`+W+vu0bO1nvW{nk~^u?q5`=-;4i>r!j*7LT$-t`W(?%mhD$*tm1kGW-5R=Z!c'
    'YB@JQZmBTq1okfGsSjbqUi3H;1*RFW_s~OS?ALf-HZ;)gQ6oOXV%wr((!dsGxVDd_I23z0^~^&olYp*q_^o$h-!XauCzGRY7E0mg'
    'e4sgT>%Fshc^o(}M0(R=(U`A!wQ0KE5jUNTQeSqS?V;-RF6ZB<r_>E`^p0@llR<_1#*!XJdyRX7V}&zr2(H1+p}@xE=6EY;rTf3e'
    'Yr$Y|wal(DW(<Aw5=wy61ggV}`=<VFW`0NT+r_ECJJ<F!r65v5R;`E6bECu5?>E~qn#|Mj+%Y^_cFPTBNq3;G&42CLzBldURa`#^'
    '2IBP5rdydh^aQmd`p1SY=J+L_%-<V21i^t{TXlo4dOM9p24fy&lZCpsX*37>)mYY}UHURgx}Eu1u(w||g#|a4%HYEgf5efkTLLPk'
    'MjC7ocJdLmD0=Win*Bzl1G<bUmVVES9!?9ZI)#$CZKKhqhL=4#Jak$mGK@ay3EXd<wtYO%W^I#tQTo{uzzZ!NtZVUKsn=r+&YiAj'
    'I&7?O%gUtxSY`7?w5qPj)4?9_gA%W~gwm|47LkPe>eR1;=#WJ0{?&Tb|Bz3vsdg4cg4sj40yut%le(2G?^0zkPPTHZv_H7z<e-qx'
    '?kurHjWkI!<joOb!x4z{>|=^m5xC86X3{r@e?vM7SHS7$#qryhr_8uL-QP#n%~9K`;lE9y{f8I;p<l!`<fLxB_B>GQcaTB@E^RaT'
    'dXA&Pb-nxP``1UOKa5Un+b@#I3Auc=@S@G5=gkI3F*_^9@(ql(y>}jWjreW9Zm6~Wv2OBgwz}EKqff2brJ_6c9)yS+bYuNGFdoG$'
    'ai#^_yKH<*PczHplO<O3X>V}-4n}Evw<9>(hG%L)c4tea_ph)%+sWia-)9WIu*!j|z3EtQ`kSmbdZ2-5(O~vn4??bCL5w0@-7^lD'
    'obAAFU+>7KmWI-WsF`T=u+Wjx`z>bcI;7^SW)s~;S5B15mmp*I>4sUtOzT1PmgregPT}9^JeVV~!~lE_R3(Rb(F#&AURz7|9wtZE'
    '0x60c$P>t<?I=#$uT(QI<{s(>I`{rnx<V1*%?y6CnsAF_1m55pW!pg#j;b>_+O!Wnz~<C6<)B)~QPehcLoV|A$$=aQnUOYt$a4m1'
    '+Ot9gXM=%@+U{WA(q;$SZl%+ig@P`OKZGA?@l*xd-JTy@;)9Dv{l2&wkOKs&R5lpsRJBUm8N&&|Xtm2xWdFzUu%RI+>83ISmE172'
    '_XBgxz~MpPd%R>3UWvqAz#fJ3BRmbS{;SaH<t}1t*_P$Ic0y<2apXjj*gv0zz|s}C#MZ?UvkvS(Pk~ROC|P>i+YUNXW4>Z{7tb5<'
    'L2!H0X1sMEsg#IM;^^7EH7lNx&poYcxY~!&mRPXp&Ebn5j^2*aqnDA-16({hm$#=W!X|xpc=kiYGP?ET619Tvsd3jF2U#+A>F%D3'
    'f?r!<?MNq=aGLGhaSManH!G(3_-;JQBON=m!v?x5AOSU&1hW*)<;5e#>ICRoyEqeW@A_cvbFu~00Fg54fGy@$<R2d*75t}94|7bX'
    'cl9ctk3JTtDF;%8lPAbEq66F04{eVTln{dqbwOz2voMYI_?_Amp%G&^TXR&Fk7d4Gmn9eACfBdO;B`=pQG8hSQIaagxkZvBU{!QZ'
    '>^w&L2Ncs5RW%dqHZg)1<p;{pp<+IGj*@^IBRk0uk9;xAD@S>fO!On<sJOV5`7&@)Fgsx4s^zK%xclK2Y8c5lrt^FPml2(z@OqQa'
    '7CGLn7v;f#b9UF3I7*+3aTs*)tARVzsfbGzWEo}G8R~<m+hn~&#SCpaRziUr=x#4tPl}Zk*J39DVhh<WXN7Rq(c!zJL3Ff|d>)vY'
    '1)%~LFbzmf&9}LlRYnGA0}Q+;V(mUh<zedef(uQFnzp93;LfT6b?Q`Io=GZPmv<%;zF=Rhb_rkV6fyHPM~ptdD4z@{fr0};g=lXa'
    'JD5^2&+eex(}8kMs@+&2QVs;-blAmkbz_w=XGTb{DJH}qJ0&JbN8~}BNr7P#{eDqbSS?oJaZN!<HCBe0S2+1HU!ki74=8O2$4TA6'
    ';TJgcbIh8Nt!FFCUIy^Oy!Enusy8#>Zz~fm<c2iu1>>1`NfgMAOHz2l=Y|A&%x8xF2ORgV^d>qHy{R-s?`gO(h4>;CFx~?Ap8?`m'
    'i$b<dcY<jFi=4qsm^dKW<GeoPnDWan->Pe?n0zOB<9_*tKC;FjITmv=Aub&2MOCtKlPyvwI?28yl<CV^1yU!Yb$|IqO^Op^{_;zY'
    ');Q1SSE!02CtW}a$(rwsezh)U6Uv9VT&}SIZy)KA^ATn92GQz}yjYDhg`8tNxR_n1jwAq(S!$BQB+MA#_|<^$ueK30#$yHSNBB(0'
    'Sx{t`Ai-3ZZ)Oq>Ynxgqa>?o|CmTFdBgPX_SJaZN>DPQ&VR}y_LM(2g>Y7svEttL^tz<Qvha1TR=Qbt_Kdf+3oB9N?{?vGu6?1OE'
    'V?{^PixQ~=+;a=M4{FI}Y$BJ`q5+zcj){(|kYWSEi!uyDAA0D)We&bs{YB}as8BJ5Xk>q-xIvgKur$>aldQ=-3kzZQ8Oa22QOdzV'
    '8dTrJL`Y;>=CbA)DZ-`kUj_Z?gaH>i*ubg{flH8_Pc$sSu%_+#2|327%c1Z$PG*SO6!K(AS-64dK{*Yh3;c&T6<ikIThX`I#j20;'
    'VpV=;k3*NasWZ9vE&bUiP0@GGP|S3Ei&y7&kxpt1yAgd0I|5H+CinpUO!1-JUu_vG)xXWIfN-yYaLe6caxQ-torBl{RCiWf->is8'
    'T`G3y!PyQ}5^Vhdh~u64L1|F+PoOI3A`{GwASrzG@1hE4R0!u#019n=*3YOwDfrA!^xI!qjb|XZ>0hhNdZm+ThO;wdOE)>gL$ftp'
    'l&3F#7`-`+kPF_9di~o2+@Y5zM?a5F(id-DQegI@D}Ws9k8QNWJ9mIDU~fV6IXN>O+9D2L9-bYtaD?-r`wYKlE8|ao9G%cxOR0T)'
    'a`YFneu~*sw@<M5=;Y-1WXGP=mU^Mu|Lph-UVZ;}PCD_`!IS9A=wScJGx^U&`9*|5vx-}#y9@JtV7eE)fUnoHY^kq3W}{h|$5$Z7'
    '6JvbD61}Y6jNW_?V10Y|X0$Ph#h%JyL9u|Oz27P6#p~n0Y#$sOUkqjy`vSZ;etS0h+Zllk+4j8w(z5*H%G&5X1Q(9|@(AIpx}Z-B'
    '3{%tVFEBDt{4T{>M0JAj_9VFj$#;$^pGXl(Suo4m;-5q#MOPAl>ecbd_eU>Zj^3t!`Dt`|CcBHf)Ky_79wutp+Ia(~mQXbGj`g#B'
    '&XE;vg0$RuM<~08kfMhG!O`E2FnQpspH4@J{7>Zx+v(wfh@_`yhbL!0y-N>IUi<)u%Ri6pOcz7<CFhIBn{<_P0!QMX)J@Mqf`b3`'
    '5;x!~zpI2trSNv(QgVbXY~IPCJ{fH=)t~6AghHR#dNN?RX`tBn@LT({<OtMgIT3d(2C`Bp0%9&RRw{Sd5aI?UTalNdAvnjz1FBlS'
    ';w}mOn|)7|rPc$96&qa_S116J0or^F{a@Vg(Dg8Yf0Grri}`Cwzot?MW9Al0#M|w0B0KVKCOv%5TA;&Nr;11K`X4m`{hIsYV??Yy'
    'Y_r;N!}z!erWq?cTua5E%aT2mb+&=i7>9QPJ|EbKww0Y5EkP=twwGPmqJQF8-NvTd026V{fRpBd%BYX1l~r@`BmK2cLMbhSsZX2*'
    '5F%NzLqZWb9$%4OD@YOBpQBDvH5|e$EXDi(&)&OsH<4s%qkkofK0PTxN|ueWK~&Zn1FkBc2Ag9{U&d(Zl`RRYktMZK!ccDi_p`5Y'
    '%ScIvs+sxl_N*za%*eRzh}hR>^BDe=d|2*0X|?#j$uF#g0YSdaP#e>U!>Y>~<89xYB!k)20OOs;2`098awoVodjF*sK}dkZff_nx'
    'nAw^!s+iOxWXZ7M?!at!<y?nFz`vZR5)ObKp`&_$48YO!9fJ;lPWXA^+7Gitey}xBf(ej&z)K=Gp*hp}#i-vWTe$j}4awJeL7HT&'
    '1>2?&3FuwDT?)6NqRmm!2U^1oMd4#WT=<w=te|scH)evtTWN3T-QWR=jV4>tA2L>6Q&b$<s$D?xl9v69;Tof1Owj~D@hGBlS5c3N'
    'vxNck3TgS_!E!NdJY~jAR6Od2hvhhP@lCS;F>q14K+naNI0548P6#phnb7JD@0TI#M{3YG|HtoDRT?i7nimZ%Jj%WB${{(@iCGoX'
    'ozFkgFz{dg`C0sGwL}F=Q9_?qQd4i@+Yb+B=(E~(=mk5CO|<Ya&>ng2AfhN8L!`ZKb?Ro8NH>k=>|KENA%n|ot9IAXW`~0k#7ay&'
    'u+oY~0uqKURAmf8rXb%$0^nvF(yXzya|3=F8?;R^2cIQgW}Y?Qz`52iAPe{TkP{8u_bc3*6eYsSL70Utek9)^b|3{M)8|g^9mj?O'
    'OT4@Wp}E$Yw)Xd<AOmvDSeD(n3K(J^cmuw^qTU<cfowc~Q7>5bv5C+PdCmF9wA%N8Jn=~MU775M=&7Ka?8jt#edmS}2;uSUZBt2p'
    'tAE|uR`Of(r|$q~)R1{4hu|K8@CZt}96>O*uBXPS(U6*8o9BXT<iuw&&xyJ!Pl4!$QeoN5=o)j=X_t4AaD|R!_kewoC4S#B?ze}X'
    '&03-9oPE3~CZ0ZGQm5PTr2DtiljGO_0B(qWy*xcUIMW}8e}DN}|2{tX`Q-KMlfPw2Yr5y9KOim;!*=`Bf^C){>@Em}s=$-K9YHV_'
    '9Rzm{|AJdRhq5psm}&tkXn*`ost~cI9rs99j;o;grn-tMPfNHGrZ6em_*rj$1W#&#<4X8Nvl#t`P9*r}H9;HjpJa5($wEx6l2m{;'
    'aGI$sX~nBlDGbgO3Tnm5pvr0U1>WXICthXs5@S#fo%X_~sf3N4_M>yYgTByLtmf0~Mn{ejC3tVB;i|u!J2oe8^D<qPh!%JYr72XI'
    'EP}?d@30v3ikPDSIY9ga@-oCGY)`c6;HA4=LeDhwfUkp@3Cqf4wiC|GgW*QRpy4AV5>kRp7Ie=u;y1ntFu=9Yiu_My`p**iEZhhh'
    'Fjc=R_11t&w)G2L)>2WS*seDkobc+RmE)t&ybRJ|6?F1<^|+`0>CIGvCbfqAlD6-W8(C!tAfv%{KMlTWxN~)Y6<mb4)k@A#o{NY&'
    'Lbzm~B~dRI=h$)FBLcpgN8@Q9y^#P>(I+%7n(?!K-UdmmbGN3;u2v~3D84i%2a*=6WxoIW-|zpgBR5xy%&bUxt40q^;nMcfx2SEN'
    't!<2(gRF+JjA%1{a*(Rl4m2@{W7Hdt=Eb7iVx$d&NWVt>7d^L#upTZTCKn;O2o;^J-KS6X_gK?{McYv<uD-+SFgOG;FQ>0u9!FUj'
    '`}_C>`W^Z%O|Ii!2oyvYoWrpy^Tuu%$XeqDhm#-saF^6>sfH%(Q~Co0wFf1j{(y}d_PwhPKkZ$+5&^R?1_6i*R9yMw4+^E4@483t'
    'P7i;nF*~#9A{!&x3VwhrPV$q?ee7CyMlC}{e;~R$e?xa5XWZUxF88u@lP+ej%}2?0-E+313xW|`Y_U~~z>Wt#UxDqEx+A9`NtcEW'
    'hoix`Uxd(FR@>z09A~`|sgKSX@Q2hHgcq2>7(6t>GI3|g-jgSf_iP>z{$4PSEc7qxAI3z)qdCpOj_6TFq;8-t(8AGFVKg>BqO$s7'
    'QC~^4y)kO82YvB*sGKKTyPYn)i6T&*u`L_jsUem)=HM>R71dYw_hrn%aI<0JN6sMK4XDE!ONdrL299o570#lTaX)aT2V`YTD+fIg'
    '>`qozmX0rX8u(sU(9Vsylcr>taiM&#dbEAo+*W|8X<+<T^JA_;9;5}ETz3_CD?aq`NNJWvMOW?ltQ-~CR<T(i%~H&R06gk91aV=C'
    'SHb>;3vQ5DS%HAMY;wfW9#~y=6~)iQy3NB!`*as(ss{f*@8MT;ARxe=qch8rhw$vCA49Rp63LsRTjOynSQB;T9FMub;)<tk9cXz6'
    'hVYuB*&H91`GB&mqB=?)I9-zq2Db>{Nz7Elct4^Rr>0yGM)YQQ0DsA_eNavzd;ZE@j<6p28Z{<pQ8F7toJ5OBZ&qBPtIZfWmPz4`'
    'xv8t-o($5YzADfqFLzuWP%v}6ussKZ2I=Y~At?O*f3{(SKW+5~pSLDUnEQYK8|QxU9CpxX2>(Ed|NQVE&3xmd5mxC|&<+6sAW3u_'
    ';Y12b4pZLAj=CQN>e4gGuO$Dvb=~xH_<#2a`mb^>m{N`bo|h)mGae7P#ab(O4R-z<WCwNZt>H{0x22khdGW22T%=g^q03E%)OFFt'
    'M*Z%^XpZT%(2uP)le`ZZn+;=F#!|7_dEWF7CZE~rj%#b5cY}7Y0OkhbRyuBq3Xt42b5@}F&NPOy&G{`e1iWbnY(Qw2BD$1+I^KqU'
    '!L7hjjmBaw6)J6foKF$$o2}Q+lkMFdw8m+^L+H^bU?Rs~yJXH4a_}~{dO~=#|CWI-Jv$9{x<8t@sdZl+{`L6%>(}%K$<3|d=<Ojr'
    '2Try0+)<WJKIicNGP{_1sap)lE7m1x6ZnVIE=d~~f@~aw2O)P;jL5vAIY-|e{es8@Sz>?x<>>Y6`bLpga6uy!*6d?VN5I5T0uvCn'
    ';w_hYJ)M49&Z=Ut!o0`T&1<8WjiF|;rqwsAQd5rE*;hl}ml+x+BJEidU5wk}W!7aydxYj#o?c%sClp|AdMP`gtTr$QtT_v^pk|Lz'
    '+obyrP297$<?g{2TG^i$y<)I3(<-_dInFQSbj^~}oP2L7sD!+4VPjq{FvBEKd~?ls2#$~=(tBf$Cy|?>Z@^dR@KAfa(UlIgyG^$?'
    'yhqJJ0c;#f<>-#kpHg>`<k;O?U`*8ueKwj61Ow8I5-k(3N~=7T=GS`CX_ZaTl~jN$KzQrD@x7YoPedJz%pqEm@vN5@Qc_>IhL$j5'
    '(cP$WdzJ97gECNcB}TRpC5bxVE}8)2Qwy%PAzlf1XmbSS&DH1<kz)Cq5Img<yN4tU0JFIXQ`fwjB18dkYfY$uEZ<s_rvR8@Ry7<$'
    'O{*Zy$ltpse<_=&rGvoQXyMhp@_7jzi!F*|jc%DC-#{;2ozc%`b@-w??cI3MGVGN>%)GdR<8CUp*aiH#Zc8l1HpF-De%*Ta^VwTR'
    'Kc%-(m(pZ(yR~949%ksAE=)<_Zxmcp;{UpwkC8tW*I_pm_;`q>eKeNOX2EkN2*mpJ2_z_nQC@j+`|zQ~Wk3eh%fXIXUx6F2=&sXZ'
    '5rgm74}U#*cZOa>%nDyE7PF$gwbh%Ang*l{7-8}$(X<F#VGaabQ*6g|RjS#_Y}NFm9@3U{(fuHKL{DALqEA6FP|ls@Cj4Mk3l<OO'
    '43R`+W9auyET=}nTl6Lc4wssuPHyk)H(T(3+agN0w<#N(Ggebkafz-_$U#fTq1PH^T?<R)T1pCe-K(!useO3h5xbcPx`+^g<=3;b'
    'x9@ygJ<%0hYzUd{O(Rnxr!@Lap)cuS*Lzx1%eJ#M`~ti|LN~mHe{;U0&<DgPnBXbQ*9^tZ6p72DO9b&vZ+_kF4`v1P>TSJB-72X?'
    'wW3p)AtCYt-~3U$4hLh#BlNFhHMNhYA3u7Qc3mM@pcezEb{^*S(!{~Qf@+b3$pcQNziuZ{d;;pGyC1lgnCY22keN&yl6qJqCV5U?'
    'eOgDyic?`_7jX7{@(8xn6FiHrx943R1N_-Df9`Z6+tZvpdJf%{-Zy8{nVu;xUmm`DXYpSMt1Y1KOUsdUQ77O?Ugyr4NFGnig-Gd6'
    'j+9129ChjMe=SFY1-W|dwMa6nZ^DXO;_)&Ealh(*UKaAInqT5BZdE1mR!g62(mPndGF>be67RgG7tzGv0ob1@?<epvkCiYgvHt9-'
    'ayea&`|j8N?!lN;-F_i@l$id_&M7r-Hb)7$=9~7@{rA-GzOUkYE0%XAHrHr#`$|)44?}NOmG}AZ;Fi06mx$}S&!1rWZ9aK9U9)f}'
    'tb3(DF(J1qme=STal2drt2CGwtjq|@n`GX!i7WXXwm7e5hT<<Jy}QdR!5h7j=mtX<{jJa2z>&-fW(>Uh|6j`~NE*suWdypGQ@$Z6'
    '$r{_h)<iz04{XM3zMJ0y8w5`scu6RLbEyeA`IV!R$Cs{}-7e+71kcwWWb>5&t-<4rI+L?Ujh{tcS0pcaq8zyQFB$ktmpN{tm+b4&'
    'IQu#qU@165XEQ}(+R}sb;lr9VByhubr7R3=%?bwbc0T>`^;dphgU>pg1IuN$Xrf$XPSie;r)W?Y#Wr>MZSA2pT3;oD8t<RMoXxpX'
    'R~G6>*}F`VzDIF$6vRRcvGsB1$(|pORgWG;x-&df8}qcLYsvO1(*j4KWZHOHEOs|k6ZyJIW3!QnyF{e92*ewW;lBOns#&vR+bmaV'
    '%TfN~)^6o3WZVGAKvtEU-k^2ZM$g+jtyX7^Z+Yx24xAf?0aty?BfeAHJfFvK4dNmsw{~QA?c|pGbr-SLyNrOhmhVqr3r`>p1of&#'
    '{ig0(Kp=7?sOVYQx~hc8-u8^!E>|FLV@#%JZy%8e^#+P0Y<A*>+|-P6K969<emOiN;1)R5RlwY;1Q)K%UdUj;h&YSCy|l|exM`O+'
    'nOuYrB@5aclj)<^*Ns7Xh1gYX5*O;^uur?pjlsVC#;K8H99vFK;@@LpY`5++FAAjcP1C|sm`sZ?qmYH<A$m-P$-e1L=vxs=4My)*'
    'Ejm!;)^d{>ElRo1w&pbli#ELW{E2LuF2a0taqmUvBG^osW_*=j53^OE_6QZJaK7wEz?EwDt1fEx)>WXllv6|CVHHp?YtK$*iw60$'
    'P)sO-M_|<G*XN|WPA-;xOtyz9Lwe*mIGX}1@-@>8CG0SE*_-t)5#-fn1R3HGsQV+KKP+%j$^Fr2$Bo0fA|VQ#5QEVs3YFlhByW<J'
    'uaC%@+Z4ky^@?;U$Vnk<PPn=lY>lB~Y!u#_Ai~7f!OOoi!|{82vWCb2H8qvkU<J}hD-P?AdCd14v1Rb%(prYqlnQK6p})4V8vPR0'
    'RZ_-9m^6ancInH=q8@ZRb(3Y)>gpu7vEbIX7`I-YR(|C)WA{!Zt!)?=<G_Ni)4M4MnH(?%YZ-TPqVYaOIUy`B^G_gOwKmi2agD;c'
    'S_>0$63{GEqm_njvEMjNlu9DzOsdzR3+0pH9v#w!;eMDctXo_*w|@%+svSCX%@rUgv6I+~GHp;&a`y-{r(d>FDi2fw$>bUD3)zCC'
    'A);t8D<WF`kw2O9OLB)$_c^%{DyKC#FE_eS{q>&rCIzE^%#Dn|#3l@#*TaZGZt{6B1}P}2!76d*VP0$f+Tj@}@>w3kiI4hmu1$fQ'
    '$$Bb_Ho`!`{=n0Z2m4g(GD$u7djpnOv&ntym6cR<+tx|_t5+Q|PA&TBx&6#&d^XIEvz(BLi5v&{w$T8=@`QVn#JM76y>L_URpE5W'
    'DclK9=!#-QuixBrtf|!RNHX=<wAI%sDkJQuxhf>BxQ-D$L+(EYIgFsX$@FH7fbiELQ1c4-UbZE$bd3}+`B)HQJUUGDY}OQWmZ1)O'
    'I(M{puBm*}4IlJXAmaL~rL`bIx|v54q{TK*N#LNGzl?$N+p++@#nOOZ;sGtd3!X1k42v{0LRV&JF)C^KmdK_ul?O(bN$!aiw&OQ8'
    '1rS!G2zD2U?b27If{U*LAxJ)tf*_a(@Vs^&9@A=OHVuuJg$4^q@}1ke%zsBIq3XdyleWgp4mB+qaIRJIvhYT$-0cE@L~&bh+tI+5'
    'xi$5t@FcDOFu!AV+Vc^i{A_~xSG{sH5oX!YkW)%paQgmOjXCUhk92izOe38Ys}_jWGN=nUOmMp`rsz8}8Uo`^*%0YWD#sq<&E=rG'
    '2b>>GK4U-_zjuB}o!yRci}d=u)sc}qdP+$QgfB~JgPfroDH@O9$Va4hmStD)De-*Ue75@20UwW?tH=eDN2oQ6Ji15()5=cRhX?=3'
    '{@ZQ1c;v1{uE?kKYmlt?G7pS?YkEc>>fz0P;f>h{GozY5NQO4C@hAi)Hzr3c1@BQ}2Mr!~vPE2c)nDjXwZvm0fY)$_0u4nBu-H6l'
    '_HFBQ@6sab6fg>C*A|IgrhiIKFrHf=L5bE-|I9XMsiNOZPAE^No>12V+`OaWx`<UcA0YOx2hK{V&KbRHph%^Pk1!3ry{tK3ph@)<'
    'JBML+q8e*w2k2M2Z^(^pJg&J#^jIJVOrjt8sLI+_Mgyse4l+ab4~917_#+4X!jUTcwI+k`v@3|U{(6OEyQ(R-7Pmzc@qun3T}?hy'
    'V?~t#x;RD@0D@bLVk8kvvBCf|QtuWVY+DF{xTO%g$;D^_7v#t17F0C=MiK<ZycB7{fyVNlRZsl4nKXt-&P^pvn}*0_0(WF$gllUx'
    'p7k2T&h6tJ0@kJ)R?V*IUl>r~z&r;>`SpMda1v8xDxmDB1OEiW-+BaV0Ct^yZFXQI<DqLyP>Wq^v1=^$P?nx-G6e5R60~Ijs@6W?'
    '_9U^FO!d%iZvh7?t^_WC^R~;UWf!45aU#hR-ww<v>HC<<1?WS23gj!A;tfXjWe=TxP(S4=th_8p=tbB^?G=W68c<hh)m$ND{Q1|i'
    '2VyAfT=eaq519EKFAKLifoBm&HHQi3qXWBQvObB+fXUm$Q7c|`jE*sp%uzBfzRjA+fq_wmmn;k8>fGSk81!7XHW<_hC`yEy22WT6'
    't0goy3));p?QZ&smMlTZP`j+GG?d5F<7GpLpF5URobH&@T!3U4iID4rl6D~y)2!>aMX$!ro~C_Mxio=dk{p($4h)&17(J2s?bBEw'
    ')pw7uvWv+W4<9p3sByDJ=*_$(2s_85EnmxA>LJA+M~@ly0i;G4N)?~0vtX^hwn6s{nQ+c*sdDYPi%^=G+ZV!qQpQYKSpR*O7>(5z'
    'Aa^Xxq?QnXImwZ3=fZd#Z0=mT(&65ndo6clK^WX-^^&MmB5PyMH(3|SfJE8cf(eTsm?ImMx#@mbN7Q`&D&0WGoUfmgU^0lMAE4NG'
    'Z?6(rhZ|M05HvKI!J55Fb@&_AJlb@ZhWQhuV`eMx!Sfu!0(9e!3MV~+x@9jXl3UjjAU`uS>MdAQ>&_pn;noy<YUDK@VSp%f(eF;t'
    'oiiY-?wT#>c*c`&p|>az!}>a@9KN@8vOi+q(V7|D?F}k4WrLm)9+JNEyV><QChmHSU7|Of2}}7NBpD1Bw-vFl#0GNbC&_9esYN&`'
    'nLo4K=)k^OTy#@iY{FWtq8oQXX0wf?RUssFw&T8XQJY03cf!<>zHmaj7uejEDb(}~1S@qA<{L+oV(YQ#te1tk!&JK;E4q@I^>h{C'
    'm%2(+Tz0J*0mHKP2<|!x<+`hPj<<DQ^)022YOPmuuy{b*oSTy1s4+2Sf!zZoref8Ck-pOAQRlBTx83=CdgCXFC1QuCNbX#>FB!ut'
    'S;bE9hDxiz?0LAAwQ62jQA$yt3=9L6SSejCxr1;rFM8wYN1QAJSrG0V9<Q3MV7%OzX-(Q@q{^bnfc&BsGT*KS5~Ocdb(lKqI)@OC'
    'KS+u(JRl@)yjz@e7!C(obxxUEG&y^i)0j|zIPaooENy|i#;ts6(mtZmw0!<DrPvC|ha7tuSZppw>;>pXlVgn(K6S~*-p-Q}Hb>3J'
    'CAq|;*#yXeW`a@wywx!&!6Xs0sJo`q@rMU@R!v?Zhi~ta9FA3OcQ&1Q7MS3yrBqCj987Q2@G8CkG(z*d8n$z6&N9dH^oN{hG3r%S'
    'mZ`}f(^0wTHV07vyP6iFCkVST8dfX<C7fc#4P%y5&>Dgm>CzDToObsSc@ZF?8Ry&;{bjDt%E^SYzfcrw6m3b9&don(O^2kw!mgAc'
    '>MBKiM=gM!uyKV!mv7A)*_>?RDPm(>O1{>tDD=>#ZC6Rkb9wb!4vkE7OC#=`k922^^j!v`HBAPncVWEQ$VGwCB@DUWCXG!`ZMv_x'
    'BS5Dce2o~n1WxCCdS7PPCZr8cEjp=)EJ_XnQSxMwLsc$KhpTspQ?BFHv{_A`Mxi5pwKB9(Z@6cxBORGJ99&Nqg9ar}2<LO_x;KIQ'
    'y;$gitk^G@oDH#o!s+DZo+n}UHAk}G<1UacTtQB+c4QML#prT%Pney=awb`Z#!+*H@wwsi(A@`UEEr8B4nR(7r(ONPUwzAqUwn0P'
    '+7L8~*($-c5yqBOs018CY$@YL#@$)3pdlWZyDm9A-Q2qr?h}zK=mm{|n{nJ#c{y|b*0YY4B|$d6GhTn`Z29m&f-57OZd(sM%gweO'
    'Iga@Gw(272SEs^72q=}*?A)Sr6^aoG|LihX*yh2mJo5UZg43q!7{~?}#)hK2W#@-QErtaDlqCdQuCrp0H`gqrdxv{+Rmf_QN$}!p'
    'ncfw9Iihr@Y71w%vA?&<EIZRunhs~-+d>+5>keRTnFqsZ!=m2A!SzLaON3ULk+Rz@Myy!o-n9DPNS7DW`5aS8G<YykN~4*I)0!FH'
    '??Gxb&#P!mIufO_ilYqkdD%0J4=`Q`b_(KkQU){TonFmf%EwjgrE4S)AqH+;CthnjYbUNzO_UVQ(zDiu*V(9*+MF3QP8j4Y)lPiO'
    'CZj}Z^K=IaptjX2Rniuc4qgxjc9{7>w+#`JsCoX=38HOl2<L|fc=h1}mISJfK)2?|=C3+Z-OtL#_IAmRRxYCkG_R^kb6eYGcIA^h'
    '#j-tBm91e~$k-+fio~Exn$O-ODH}P+SVey0qd8Vcns3f*PMIt)d!U-H+8$z?GFX}Mlb_C&iQ{lSsE*T98O5?PGgnhM_ta%idycvi'
    '<0pIpvK}I*h?g)Wt80Fkygz<*_!_;A4qtUo4_}_ZU;pTyygz&U{>)3jw1R>4i->N#iBW#QfpbEyiZaF^81R-A#dXvT%_6z7wDMbG'
    'JX~GaSx1xYFqY?Oy-23$hHO{nzzp8&8heYoQ2v%a@~@5Dn0YHj1BPtwB`@tGpLE6o>QE_XvLunVVab>##)k_-RKh&*Wtq^1s)YlT'
    'KZ@O3<u){}u*tR^8H+`4Qep*`?q1<8i8;b0inkg=RZn^mY#m2d0<%=`C+EhWRG_^(r(<MlzKMx-+cGD(QBPH}pA|>0kzpM!*UR?~'
    '?1VV$cV%NqM6lTG*x`zZT&`7o&)A|g8AMp-Suj)dQepMlQq^oA9G1x{jqhAM!n-)~>zef<S6=H4yiTQ4b_57CsG-Yk3~K?q<Y@Jg'
    '<>H4P)1^9g@0HP{)2q+*jZOd;C1DdbZu60Q9y;d0aIZK$H7a~1Jl8(O&slZD#ErFl&`?H=bvV+LCgCoS=~ozH1^=|n>p9sJ6au$?'
    'XU}~(>rLv|+Hm}}jpn1W4>d<9;!mcEP87u0YEz*my{l^KJnHW8j!)eh6}^EYG^~+MjI+;5L@gEjZt3f>%WdX>*fx<7IHs+Ev22+W'
    'U=uHAPGF5L&2E(`J$C$>O`VR5wM?eVb9UTVc4m;gj;aaBapd(r-`oL~$=}KyENZY^E3I%{mCpKp&-fv^mQ&B7xt^>728c>xjbjeU'
    '_a-STNBxgcl(=IB1f`D4_lQt{xp;H({`l<R#p^>&zx(d&;Oy|-ss$dJNw5^@bjcw|mj=B~YX<hNyS+VH^Y;Bl%Ry(hW_EYo-%6$v'
    'IqI(c-0Tk4E=RL;6?vFa7CLa<oPMfJfaV(mcCQ#iDcL#8Dj=um=b_?&dtmU>Dp^byiCevcH~Vyo2CPp5=#sLFluD{K-8X5gBzXcO'
    'xKsLsx_fsqRz(2+MDZT*nWDsqS<j?Zcy)AIomOEv>XT`o(orrk8>Raeizok)Q2MuTn`{%tRBPcVog%)za9KF+7*VwIIb|8_PNov&'
    'USlnm63_w!_`$+~#&@EP1O*Nbj`6afWWgwDGaQYN11G7E9Xk(P#F$cgJXj30GLBEiJc+$|f>GHD>?S?)<Zd)0WlS1W=BhXEH_&;i'
    'sZJpmmuU5*gzn9kuU@~FkVKe~F6DK1bLA8m-P$K;ANk_4dkIx`XEjQ=AtoK38g%SgRf?yqZnr`46%Mg+Z-E>t+ajQ&%P;;_s=(&h'
    '@g^@yZ?RKrY-2_->L35vM_t3V>seW@zTcbQ1n#V{`oDB1vziV)OLpU0TBb??H>uIoH4l$Z-u>epM~lW5-?)js#(^T~zmhJ6kmVsx'
    'Ib+P|{K7o)VwKQWO@|n~W?GnJEA)heMxCWFSgn{WEt=aPr0&gf%fKmc_!84kg~?{3SG~#BHdKpl8Kf4<FyJheF$cW>DVEdbgoz)#'
    'A;1P6ATAf<kmBEziR$`Ofqx4;S`OD_lkjH9(d@2C2`)$ToE~w~faq|dDQs>kQ`j)pGv$LJ1XouK4BoHKbyuDHrgWN-ub!EMIs+e7'
    '&V5k2xtx$crlkAnPCvPaMvRo~Y+01s{})b;i2*&1V9{37paJ$2ZH^w@wjvCcH5Cm$lT^dFA`cnN$V){MR6S;4#?La=TWEG#v;#Ns'
    'KQ;Dcr0Ve{{b8H93)7d>tvS3RSCbjk`lOTxZ{Hpszq)r?N+!nM#<VydmC!7|krv(bUM#`Bo?d<`>H7-2JAYKW#7|pBQ97O?)LKjs'
    'CWY~OY-6o+4NXxyp)<4F33v5m!4z68fZC?FAD3_kcWId$+a9#xCEW(pyI5}oB{=4s?}EgmB0m3y91)zc0O?pUB%GAt^-eT%)_k$X'
    'rsiU7l75TWt*gO!M*3TI%_qNm&msv-(-npnB1?(64Jqaj#UZ@-I7KQD2OMD6CTEH)%3$71j(`n@%hr#&SuQAP9|xUWPd`&|npsu~'
    '<WVOmKF|gP(LEoG2ff0Lm7x_Z6x;(zK+ZG&A2l)S<Wnyj9_bV=b#S$C>7aCCdGn09x!_clb&zlF;}oyEgg$jRVw8Uqsl{6gE|}}E'
    'x5~q|!F6$*j*#y4c%w&I<S;vZ^|#aYN7>5c?A4TrO%q*-3O(_sqymkgJSswAM5vbKoR-_oI_C};E(Q8iMXES3iI<0ttM)`D`-o_h'
    'g1alhKAZ~rgU^}sF>D}q$dX>0BF=9tvk8E1KuRL92Rl|LnRad&NH+>iJiMGN#&DqkiTP8R$tz4t*ggC^kcjj9_(eR0$qTFp_>!ZO'
    '%KRlET5arBF@uED3*%u1bZSrv$Pr_S6cwbSTH`L|zC%QV+D>eK<CCGXI~@yV>)~$L_jW@t>Yw4JJtVokYSetEjQbQQE8Zpc#w$fx'
    'ltQmbRRok222OFEkw~sA314X_l}0tJF%rOD@oLbJwVYAjSv7&yafBI}RQ4Q&LF#-}_||Ir7*-GnO`Fh1QoE%l?&|lZ6#ZX(EtJ=;'
    'R}#wn+9Q<ueWKMPEX<InIlsmK-T|`;%a-3dtbsh^rOa>XpF3h|BiO(;A&eEb+;I+hpv}egtm!xMU_~X&n`$C7r~mb60wfiB%=cNc'
    'A>GHa5>;O`!q8d0WsG8CfIVJHo_2|&X1UkDV^&|djqOOEUEWieoJ!skokxIW8gT5g&&07x7RT~jeaKDxCvMhsbygjPPgascMl48e'
    '7g?Mv*=;@Bqpk0L9ofY9-bX9<kb>KWsjMsEY&l^y(DjGq&R(zeVL2SMhQXnsE&#F$E{<(RD!d$(SBxH3-&EMpc{OD4ldnShE@D!B'
    '3no=UcV)+BSOW5#%?Eu7(GMX%gCv=byN5~RloKdm^Lh%?g9#FAC^IV-AZsvtBo#RcgRd~*ZGfp&COi4gwNN_9h@}OO*pW5>D~2%@'
    'tf|F-3hEfn7-?n^V2M+5R$K-cldMx$!|s+?dsbBAD?i~yIAyT%I-~dQze;cLK>JJb7smC-LfjRw$?&$zZ?P|-&8Y69_+jTLV||TM'
    '3D!!9c^vGemj`dp-k%<J-+~0teRufs<oMM)<`#C4U2qhCgn-rk+?$Vju-(+$=$Nh@>SDC4oZZCw&=dT_d{cJ{ohu$z=UlL?I;0ye'
    '7PX_}!_zZ_v#P6N{y>6q6e&iaaZu3<>xjA_5_rFSMc~8XaCFIwe$)FTIkE>|(D8NhQ7a^uPIFPJnS*_p64s4;Mj2Iu%NbOsASGu5'
    '=&L~pw6N9Sd~O<rvKCisV-)&_MlVTCoD!aagvvPCb<vFm!OiB-zbTSY%#9#R{I$uFe~R8u6@dOJ5qAVT<sSI=kbs~~DJ6wtEHv|@'
    'j#UDuqxav@f^Ri^jWV!7!Cp=#xH4E1*DU~E)||4Op>-QSLUjXIC!aq@Z<&PeLF1Pu##LZI6!T~?U7~rj>5fjoV$5ljR2Weup2LWr'
    'E6*}SSdkbq8ZCF7F#q7v!PpV;mLmp^vR@OIL_mE&{A6T=R-aqy>@8$S7=Dh&1hn`Om7F}EJSkFSLIA2{ni6a$a?cT}>{C>7EpVVR'
    'Z8}IuBBcg?1IPv#y7FPNybnUtIyQVi;8IvU8kLETGt{LKas+BfbTdte{Gb^>l1eC^Bxu?yG+uSPf+frSUOR7mAxSo(lwLbYlr%ne'
    'OqNaAmE)H!K$@}<5x0lBH_?crU{{(>RCIF9!q^!@0%<tTdKuGK9<R;~`GL*BDD#}@WCa5MmU=hdx;a7YK69BKAGLSfyT0i6lIwPI'
    '9S$tdeg8lQ3^?@f@kcxRCh}NK27l~cad&`FxKAZQL}>oz-4yzB+;hQbt?UrnrX`x)Por6P+*^vTDKdt4t2U!cU8|Qr(D2-Y7-Txx'
    'No&<%mW8aiAsYJLD8hrAPU~_$FVWU_oIT;WqbvZiChBBUb^kj)IBJ_Mu>dih1?EA&o-I^(D2l6YiBVwxL^1d}{)v3Az8MkREoJ#)'
    'l)}bP{I`_3av-TE&c#mygToAgONK?Vh3bj;U2U^%MX&6v1Ru&3z(G1#k&<2u;hBnthZ>g8=&L4W!X`7&yR(DSv-fYi2d6K8J^JgR'
    'u9oCMJXaua?ST!YX*3)>a@$|&+iW_f__Ocj)~&qOCFzzj4o;@JusW9%eZr5dzH~b?>kk6pc7TPc#eYh+!z9>N+Mr=POm>=2;J@;P'
    'cb8&(Fe|)peYYITjfv?MGHIY{YKhs8r`NTo_2$*!OQ51cZ;>t~3lhFeA>b|5(%Dp88B9=EYMTFtxL&j>FXhl9)o;?cPWD?Z%sh`B'
    '^|PVioH2FalqsErIs3}Cp?mhS7%s%?f5wpLwy*z^WQ5oJZ)>mB@{XTX|3h0N_qk5v)gf-(@>6!Vh#`y%Vtsp)G?4MK9ytziA;x1e'
    'hyjC4dKCs_NouIJg~`9XtFv}SqnSA&Q%OH*&sp|KCnYe>jZj`L|DqYXS4=0l?MN`pvZhwk62LhCJ)V7CTumpBlg3ffc#*hs2ZsZ@'
    'kV`xe4=rglD1_wJK=a-uG3_dn6&?-1+&B14lZ1Rwfn=FBjp+s{nsBZ*KmJxqiJ&Q~zjrst(CfZ)24UUcA0~IxkRW>~_8Z$~#1bkh'
    'E{$B+rUX4Y{_Ei}Iw*DD9Gw2;@H9&fPft%y<yXDlDW#pD+UT<0rhA-zBL=cltyjlp%#*-CGcvl~OBh=M=bjT9qODQ-M!%U3dI57v'
    '!Uvs|86IQ^XiD68Tl_EF52FbxSEgi4sG6d1eQ}x`B0{uV)CgJLgpCnRm(6Sny*K9!fRi>-^f5edY<KR2@SDqt4I29P>%bnglwZVb'
    '1NU$&?>Y9`ps~~|*PUF1u}A=}r;n=q2uc*8UboYm$^X`a64l#R*V8`FN!fwGwymRJcDU5E;A?a_kR~?-r_S%*>!^$_JuqJiBVD0>'
    '6(~lTVwqXCAl@n;bmwryw{}wQJQ!yp#;=AYr(P)6ZTg~|c^K`3f1Gn%C)#05uus6?`kbtUCo(-@bb=Uhj5FaFaks@)5NiqMk_vDr'
    'Nbp9!sQ{%5OZ%wF+w52F7ja;Gs1W}>sZPBjo%hl_xWM|{K><GV;p5;4A~#M}!o<mkCQ5QIm_V&n9~gS8LY*t!E|$&{>o$)W2yC`6'
    '2}`w<Y69OzUnpKw1M*1dC`_VsV{=;QL|_IT{zy{mnCJgNKWRGaE^eC^FvxBCVExFr*HXTLRXg`W1o71zpY0NzV@#~XXtIFao0B^*'
    'J50h~(~E!RqiOR6mOeV+b&_xjpsF_UKWGn>b!z*J`t{)Yf*JMldqwXfv{5V;_*Rwa-UVfpPez43*ELen3|Hy)&EcCDho{}+gExl`'
    'WCaB#MpKT#UD)I-J|v`4LG=Gx6xxi-_<#&0giMC;@fblqSW3nJWK0)9OVvI{<r7i?euRj5<ZuvT?QWcs@1&aKI_J&77m)QY7c^7+'
    'b>uo>g^&2IQfgV5;$rmMfCN!?CZW1X#tMwEG=%95IoOQZQ=g}f^Q)8=mh+iW!-7+4n`7igIReaCv8s?c9|+VLP86;B9uw`)@Y>Tt'
    'mY}=<h5*m;eTNe^EL^oU9ss5kciB56isg0fx;Lwh5x2u~Ka?K`<AO0S*_(sEch64F4qkU({NwEK-TGt0A6_BjTYnge53KEmEDP!j'
    '1Q&v7q3&)An9tMq$M4P#-n?ySdUMZHW`l#yX1LL|$aRyvn4IXV>zQKsIamYb>@vchm~mLv;c`ALitgpr;PR8k&KE8SMAWDkIZXpr'
    '!bxh%8nhP(J>~+DsPV2hACCreQEeKB2~N?>W>t#T78mg{v;%eB>kzi>9PXr!?M4wG6gz{8gcuMS4`;u3mrecRER3I1&UeqC%7wY{'
    '!Y1<y^&ttG?q{rV^%$9aWr`vvIZb9Rhni#M?J8agQt-=@<FmuRpHZBG7Ep}5ED;t;Gpf6V;khZdP6>qDh5=Q&vT<IY{DKifRFj9b'
    '5_L<JTsJ1o4@Pp{*Xd0XfA{IM*XhN)I<a%wPa)pd<XD{N;ei1@sFm(ss;w69Tlu1<l%Rea?x~MgMR2G_ZtkjVHS3Ohf?4U|*3mQ#'
    '@%>kE+VkE!U$vcZC*qwH_<GsBqDfPP9#?PFD!84}ruC|;d#DBc!rQujX+K?tHgxX|9DMmrd)NRW<zaRD#w2muVDmfs&j=N(wxPH8'
    'oi8emfQnsf!d%T}qr8yRG1<)?+ltf@QatVit%q_y{q6*B=;EqZT-~4Ks|Yhr{yx10<~C};iP0oL1%uu(oenp1xmk(iaewTNd*U)w'
    '<7a42)JiW9PSqR*j;JtdSFlh+_EiY7x(V?6CU(`|2L!<)07jui%)swCpg#gYK`fDcLe)Y=5%5)kZYUmpX7v~*2u&*n;?d);lO>lo'
    '{amNaK?dyj%r})^jlYFS5Nys;Vw69_ta0K^f9#_DG3>9X%vNST8%>N)VV`BiNZvHX-F0-!c@&X?fDD}nic68xI^s)%(bGi_tNQ&M'
    '#Xt%f4SScA@{`W6c3I!;tGnf(^B|9EE(Vs>JX0D&SY1?vDY{%@g%yD>Z_2Qp5^7QvOT1ngcQ&=h<ZI1Gpup}BGe9a78I+X+?*$d%'
    'gACd!3bSTCM??h7;6cd2_WKIUnIKRmjfQ%a1T$f^YGX880G-xCyL@ENIo>@HdI<dWC8=H;^V@j-=2=pnhw0p;FiWnNi(Zg#F@_Q4'
    'gY{TncRx<rd?K*HpLp4$NN)lf>Vdt*u9B4^MF7tp@=-3RoxbDW9iigsu!~0q1C+MzBFcQp@*$DIZuqiUL<_2_hZY4)YK(6bCx8$-'
    '@sc;G6DeWQfJFh%iBywi4!9E+1B3#Xg`0fz^SZ^3q|#M{YNS|tgX*+e9MD^6j$Z6DYV@7;u9qOevZPD-E;b=1y^@wB5ujtS<5(oc'
    '8UNq&Da!07cG3jMALo{3=v1N`&_ZcIjAKiQ_aw$|l{%$56Vo*<X+SdRXC+xj7&v?NY<m8SwF?S~n^kS~@vkSdd`Bnq*uu!uJTlu#'
    'meUCa8$hLjAH7fFK0b$;j`MXlMJMwcd_>B%50eVN+Mu!qIm(lPlnr>I3pMrCeHS>N$&9+d`LW0A@xO*{U>J5M>Jce}MyfIqKxMoz'
    '316u2<u$skk4X1Kv*?T{7H%94d}eMTffvr4`sK#z!W1mnD|^K)1}gyt;GPrY;)auLSaIsAlMQRcW@V_R*6w21dJv>xBbCU=Zd=MY'
    '$vp?V5iNG-q8`M&Mm91ICIMDriGdxpV)SvcyoN(;I1d0EtE5ZkYXqCZ3Sb#-xgs^y^3@4a>~u-IS%C?9xoDIB!Im?(E0UKOJ+Xl$'
    'ld|uQemOfleUl~j_pk5Yx<8MO&+1Y1QK1uP9sOg2=Qu@83}c$~jm*{H=#SsaVV7##z+3m5T(4IPm6blY+@}a#66-}hsr1K<dcFH+'
    'l)DcbFuUVX;Bib_*x9lYE4^}YG%4n{`n`u=YcR<7IlWUI<X91#IrF}x9mmI&Q4E{8Q|SN#Dc_ClVTpL-6?2B;-Wh&(D?>KyqKcYG'
    '(<cSaNSWu=RC25~{Ex@^{8J;SXr9$QM1DHHMxJkiD%kR<vxw7=GK<C<DZKq-wjyOkC<j2t^w?^{V{@!bhxMZ32-qU`^xbviLPF0?'
    'AI}{(kxqQxDS`wxz20fj9hE#HhiMCQE&J4b({ZaV2fmd?8!nE!38LL3zEtlzl1e<3DAN5I_LhHIO<YtnSn89{%6LKNF^0yuarCwd'
    'abC)Imc4trN534qgtuH=PN}!IE^2OaEGbuPc!Gdu``JI_!fI~<C!$r6ap(72t92vMX4galtu&AM^AOY+jTpI$W1xhKtI4H#kx};i'
    'G#Jc$rc{F?K93NBc2GI;bDOJL-A>tSqUJrWpSK^kTF%DN`aKAG$q@r*$u;E~dH3?y!#4*$6n&6mtKsU9^oB19@>$qM6uI6UTAci('
    '<Ac~6>0X}riAeOVJm{2K{63{e5-}A;^c$tA#3O~UzgZ+OzQGiEU(=;|0!yQ6Jk$bp%~{x$i-c*=JVszUA%Iew)(f_)9%uM1I|Z^P'
    'QS=fPPPSCZWbg&H-C{uC{xwf3QSS?GUfuc3PGMeuwUP+0jAAkR2%8dPHqkSJxHnbtl~iQDDf?~{nKrK5L|N8I%krwePNKD>P0N_e'
    'Vm^F$`>7q|J<?ebynM2ci$%fTrFSLO9m7=Y?_O4>u~T2vMRH4BxNGAdmW&>=kMAnjigk+@1<)`ZtF+1x0`bY2rc&1my~T}dYuT&X'
    'lGh!{1je%@LJ6yeCwi;HzaO1-e?B;RefX+M(IgjYmRv!5V|EGDn^jkD{S7N0Yuaqrmvn_6uGQ9u89-u3Z*^9X@F*6kM!8x)6$eeA'
    '#e&zw3O3<J`Or=je7-9hxvra(!_BJk`yT3&bt=%wN3)ldj(tD*lxbWaeZxr(9T?+E;=$Wpp}qD~P(@Mxy;@gYNQ~m#tt?WR5v%I*'
    'k_zvm-M6mJI;K!b=~|!yKk7EQ$aoLy(YpQg7{LdLaY=6{u9zVYX=Fy^@QYYU#A{aQIY@~R^upIpuKL^)HQUK5-DRwvVXP8Qytrpo'
    'CLK<!5@mv`KNm^}YKfZ3{p@O_4VCyX{Llcj*zLw;C>#_HG;g`gApH`48^%XYRGHKc<_xH<({qw9S0(U@-%6PS3-~TVUPKwY>&V?y'
    'i2rhGd-#yBiZv-4pV^hl)DjEE)8-}vvs9{Ew^HMZm^oU!<BKKtRNCI&`7@+S4-O9vc1~3cwRZ_d>+5$bK%Kp`P1WpP$pY?idiHIE'
    '*((8Zi}J;-UXQv?1+ccG3MvKrYjQu)!g<k5wqxhzGqDrooLReKD?zs$A3L2!w<fhx!$zGgRfFVcjC^(1y)sIL|J!KLF5sK5S<I3U'
    '04{TKb5(-Dx#$Z51I$BpL|6JQ4|(c(HL4tP#bFXhxWO-$3j(Nd@<U-u$qhmcNPOx2nfFy3?&=YGBxwBHka@`i4@PEa>V{J-I~C}L'
    'b$Q2Cyo@Zc%DnMil~sFk7!Dv*HYyiTzb_jQw(t#CXw+MwgfZ_sIkn2E64q|O4Sf9Xu@_5L@#No}I3^d>pR*Zhwfy&SJg{H!evLwG'
    'GS~;>ekqEFji6ws)&yfHJjYzM%AH*e(CbI=Ye*Vg+)P;^ZQB?Q*h_=#v^`@p;gAb<&5%QMAs}O;Mbl<ug{mif9<k@C%??K0&J-51'
    'z=Q%CISO4yrwik=1Fs8G?P0<?$+~46St;RaPZPVE43k`w;K>~`d>12;ND5S=CZuew<mW+HXXup@K`hhh%!9C)YCmEL#ak{M&jmIY'
    'MBTrf<aryX;oBghW?ssRYcLzdsl~{%9uf;GIb*rGm=I+}tRt`u9^!l}mA>rW9GQvG*_A{~p5M^%)V$_YK)s1WVAnld^3izARF?cU'
    'm`_WT<8qCEqRWFo+$0ccq%f~C6VG`=2+_%OShEdLxQ{L6xSBYrqMXeh8Q4ZqP<FCx9Mp3&JY9xF{hzSVaw1Fa`GGRl4H?<Z((uTD'
    'DqRw@I5$VfXNRYrF(^nt!_~QLpg+3XvTnthDZQ^;&Mu1zuFjLY3SDBE8#9A*uYeh9!eCCjNF`1%P^VV*fsKT+(D9p>6)vooVHHar'
    '(YVmg$=7JmeQ&3{0%3{4NpP}=i-Mno!0+i>@=)1QFSC4RdS3FrJe1SnP;DF)Odh)NQEaJ#B@YZ)(MG~tG|4|PMVVoVngMsm#Vat1'
    'L%tsexEZRe#cUX`8GO}wu*wA~$bID#J)drw?o8?1M2UuCa92>$A4Wlc5al>6IAJuolUK{KyISo%0+?L3l!K$>LeCweNj;uXm{>kT'
    '#=1&CnRryVTiYy-Zxa5N9Z*Gk*1K3`Kr4ep=`7?^HK(0%nHL^)LkE3_QM4K6C&vHVY(+08u(|Cf&IZB#>jj#Uk+?!4_B^Wo&>#WQ'
    'h2J|QfUb>FI`P$xp;qS_gj>gK3pSQ+b)_ZcNfhNHK-{n&Ij9^?O%j%4)n5`?Q>g*-Ks!nmRjb3iAfL@NVyl}fL40Tkzr2W#v=n#b'
    'JXqPBqks2?;_BsBOi75O5{HIa6`5f&R_YyP(hD2b)7_ZPqLr9)*KsPsU#*P}Fv5Omum+nZBJO(Pe|cdHcFj6NMFoTBF8!SeD2Rhr'
    'MK^0S&*JwufBmkyJa2sUduCb=m0_XAt9;RXi~TmHhYAMitD_tZ7i*+qO0E?up;Zd4?@|01zl!@^oo{jcEcPvDf?tkR88|}HE*RuG'
    'Rl2ylmNg=^xrQdyzwH|JiFo~`Dug75%_bDI=BP2Tm3*;)5cv(Xb$a;o`*%KZVf+23j|cGIzRs?lY+SOoMafvD*y3Y5W7X1pFari5'
    'svc{bLsL6|e+r;vaXCjn&L|M7?|9XmeWge@Nu@_o0mapL@TK{$<#aKi<ma)#C{Jub?GV&L4V9}1`TDw+*F@;R>d;3kxE-$@^;ZZ!'
    '^DaCos%|`Z!2UQH+%$wQYhY4oeEO5`S0bNPFd4~tIas0-TL+zg1mNUZX=wI9bV42vWHG(|tGraX`_<6}_uu^vfS*SbIOLIOcB2|('
    'a?*mRF|mqR@ye0*o@;&pk{!K$|G$naE+)NMaW!46y<1nuEcrNNJ|c{?kR{uD$-`v3wX-Y#Xi&YVa6>PFn)Ok2@8jP)67idYQsYXd'
    '4bxL>nrg>#jE+aY3UPg)wfXexpkJL)rwSBb!3UiAjfYpQ%daV6n(;gdLBbZymVhQYjy;g3Vh(`6Q_NmPcFy0~Cpz#=@7~)X{a(yp'
    'oB`yd1Dd^vdD{)|=yev(I3H-8v^TLwewV{cj91*8A1sG4Zx#Xj;^_73qvKz?zq~(ucZLdsG)-xXVI=-|bdij%2{->O<=&Pb(;~x('
    '$`CpQ%49g2481Bc_F()l5r@X!xHrG9?I1X7uP6reDbBzWlmF#;iydfu?D_QP*NEo(^4Fu|!|u_m6v~|)oc?ln_F;lafO2vKNw+Y^'
    '@D{A})~CUIG8k_$Z2J}#fz?RGFJu9{R;{jBwa=v!D3@VDsQU5VhlxSHBnKgF;9@k{q6ew<Ho<x>7d-LL=_M_5?$^-dgs|G0mjc#)'
    'WYWMA_?Pz>rUxcR^Dm(_qc+Qiqq*b?LsZzjHrt|PT;WI=!nmHK*>?SWyCV<m(Ba$j?Pr}lr~2?uLb=Art<Dd5`d{gXiBb~t<|yyt'
    'J}CVBkk2t=r1RjzgfpSRkDmy4dfvNn7c0$>Uxc^y>|PzmW^ijlb?_JlqTOls`hBX8C+Z5QeFmentOiVDHk;vpKEi(}dYh82_eUS0'
    'hRh^4h55}yQI-*-MYAk(z-vK-igo2V!-8X#`W$P{^Ye>z3jv_Fv?D3aEVh{E;VXQ@-N5VVHr*fW?(FUD^e=ZF?`^l9Jbk*o+i&e%'
    'JZ)X{h8KhW_T!8F!PEX;zqdQw-QVA9?Y3Im7f*Kkm(N;HE(cF`(kyN54EI~Z%Zq2bd;P~x_lA4V_Iv$(_<DP<|7^RrGkmtQ`*`^D'
    '$>m=E;t5D2kN5YVK6$!x+2475@%YJQ3#!;2UhX{Exoqw3^mg{2?LXZgTx|EAKJINlx!fOYKkM&3-W^`HT2G$!`cHco!`<FxulKCC'
    '|72(QWbf&2ZzsLOak=w~HziV$oBq*z#%2K}cC&`C`FiuOwZRt-$3;}BFM}VHocy`0w`Hl)_s4Gz58k~$J$#jB>_bc$GKWN`1oH~D'
    'WRi;d<oNYJ{_Ulr)?ddjF!3-Rta_{Va+3pE@+jJ5>2`1T%$7!xSvK+yIpK5DPlWRPX?t&fe}89tZ$+>5TWshmms7UMS|ivIm%v6X'
    'aysUD%h7`$O%r_NU*wb%wbzF(XV;@iZSTpG$9tJ6)u6BH=480wdLL2b-9`QRRg-gx!QWWlZ{8HhM?7RqG~JU7)0vqBGYbCWqy9n0'
    'FWU|I0B?`(q<|B-_M6uEo7VZ8sq;6j^Ea*YH(Td#rq18IIu%{fEYxq_+54M&<XZa*rvKnATB~Pt`#Z~`m#fLNNn`=%&U`c|^79#k'
    '*%(+|IRWeF{y#^-rjA)4DP*QODxeiS={oN9BvsXa%rPPAhlwOV&d;Hg!0z&G1rIPrx!e1QnF#Uc3}jGf{<^C>B*)Nq(;=x@wiTYN'
    '+>tuM?&#Utb}$un6WssOk&QxEOO98ITP+`(=U-^5z7UrVwO?LSKFiei>y!#F(hnb6DbC%O&U0Kby=tBPA{!Gcrvt`0zj3V4m%UE?'
    'KU!aQTKGS&LvT3I2;tv~J6{^0%Av#OaON|MkX@uBkPIep?WCOyuL8?Hl;16jdDZ(4OWK1x;3;%0)NCu;hV!3_;)&)=0&W}s31)qV'
    'P31EfSj>Nd#blo_yMerhM`;?3ew)HIn6@3l$x=G<(>C)HcX&eCS%vwcHNY+l&?%4zki&MWm*@F*yF(W!5iw54d^t&VDyR`C&&d_&'
    'qu@xyLY^D2yLaKsC#~J>i)Xzjdyj|1;WpfoaF6ahetNOH-`agTfER=PZMfO?2XGg*cK7z44*R>i7nl9Z{^N_m@af~UG&9bY``&qJ'
    'MJ5G)?clFgx|Y8nTB*1f=^hYn$768v*hNdFM^%iJY#!ji^v@mmlb9;<HH8Y4v2tfB!dRhBm=8MgRR~Y3EWKWi7o!=nlJd@U2`w;i'
    'LKTA|6}?*c^~S4_rSs`{khW7+Yt2TJ$)MlR`Wj{ygH@Ar_#VwHu>kys!tzA^{TXg;)rTA!$rle=a_IV&bGEW(@5oh&1RBvZ8G1Ou'
    'Mu=UbHw{YOCsUmo(G6EihR<xTdpdlWlm+M%jUi@+IfU$AOSpS3(c7T$c^ldmu{dqBjF+X8DZESDz=gd$gt-JMEp6j}v76L3OeX)4'
    'rG8jP>YrEe8aF8~tnAg)-MCsHB%!n&p-DyT?G9$sOITeekbt1XKx}4#`cKIVm_jmnF5xQelV=)gj4uXr!T?H&!K{aWvMNh;_FL9V'
    'krED*l@Y5uBr7RLud+tTGuSpRaH&Nxh0fE7jVUY0Rf*jkrqgl4iiD<>`Z*L3#QxN=23&Ce8<LZA(Hl*0t*oxOD<!&^QW2Gn(@&bl'
    'MK`zxgMO;C4NLh*t)xmNK`j}Nu1AZU7+0-X;DYJIbI^NBeZqG(N(4jcxyn>h4A6O0T#aV*9Jg+&0T|@!Dgpz4<cJK(zY|Yru)nR?'
    'P}0W<kQ-I&i4pw2Qs+Hxl|MEtEA2h|40(b)cl9bOR7(D*#5LPYSM~*^9QZNk>0hOyDo-XZUg~r~^2S`Gse|@ILW|9vqAi6g=Bp)k'
    'FLA_}#L6-J2_|bu8n&)_Ihh>NAyu_Lot)|LqntmnuP94T=BT~hmCT5Snq%g=0vjeer{;>LQ?!#>p&VFJsDQ(Nk%Ys4;*HCHee_~7'
    'D>Cg_8HoQTAxJ6}DM)@^s!+6o`s~U8Z3I+7e6;cf{LbQ9lYIv#Y84H-g=IQn0#l!a6n-!*t2eP{RT@rT9E+SRgK=NrM%xAz4Y&;_'
    'dw`o_u6!iboBaW&bntS|Ib9$SZaCtzgpf-qul!^{DOE;zCfCwDUAgsz*GKGo{a36Q+*g>Z>)sfzr$OJ@c#PZV&leUa^lWql!QOb*'
    'Lw+Bbrp0_Ps9{djx}VVjFB)j`8m<J|C63d_XmUAT_VLyeY|H18N*ym8w2_SFni!<;tb{tI#dJaTklVXV71%i6lmZaDA~rlxG2$E7'
    '&d+xOJ*MpT>!_Psg_9?Fy8Ub?Q9WJszOYk_^ODeYyM^!Exds7lDm^G41Enrt>G;_V?ctUheVinIyJ<Pc1YHoXj!sQ=bUlQ2EG7a{'
    'y(0Z0Db!NqWt?V-eoZHm{-8t2t2Z#s&{P9gicD}pjtqR`8U=^vdF}fZufOuVmif*${u04KvG_XkCTHb@>&50=BTpYceY)3r+8_e-'
    '52D`3k08Aur$&pOmfW#10Z`<O2*8VovLA6~2l%GG$pX<ey6M`mn-x}F-)w`UA;>!gc}Kpx>QT;QiD|H`>E*aLx`rm9Ewi!NiJcM?'
    'acnE@@@wA%fG=O73poGKJ}VJF^<eYrYf6b*ql{av>AsiLFLaN0KjVLlTM+Qe@q)0rG6l)UWp9p~9v`n~{Qh>TY~IV$!-KPs2lP`A'
    '27XMiQ1|5<?y)&Uu~l`Rtl<Uq!+;a4Rngs=dtL8y^QrS2zqZ`Bw+!ya8eUEo<K~bk6d6ALjf{2o@b571&hO(Fn~_JEg&6j$A<`<j'
    '2~UiPZz>XN*exSVdT<|Nddua6Jy+;lk$<{qm6AV6U4VA@(WEdaC|U9_V*wi`66NK7Z?X`tmv)83<JX{87MODo7W>Of*t1lE;vSb1'
    'i3PMQR#ngO1`hWWOJ8+oKe5kJcr8}_&nTlS=Sws5mPQG@sLg9PPtRM8XT8R-bNhJbE|n>*tF?)0W?(9yPHMpXVvnjx<<>Bt%Ne8J'
    'xso!)t~AVrk%qUoHy_A0!6>i&JA)WfZEGvVLMhB^Sc3YluPbH-U$O;Ve4|rhW73_J)iu|#m)q%zIj}V<#MEp$9$kKwZ$WsXF#~-q'
    'NL7uufqPYJ>9rj$!TWFvJc(}SR~6i7ARJl5UumW8Ga<i7e#VLld$XBe8$ZB8?+$)G?4F(c<?z@cS^rCzy|iB6s3DUuql^5o-)8u3'
    'MTN9=olYQO;fSRxW}|Fg1x#7N?Mf9}-Yhz^S|!Lb&$Y!wj;LPOqk?9ul5{BGN>5ViwC&G~*3uZ4`G74I=~6s*y4l=cO$(Xv0xqTj'
    '`I+G}%6z%13T(*O!xv${y(@tC6slfv9x)mTXrKEYPRE}xf<2KUBaR1G4g=5lL7(#;VRmo0a>yQ*6w6E0=fW06zv6;na(fG{u?J_?'
    '7}oaa6{S_}j|WbuG0n#4<DBz@^_DRBIqEg8mlW`I-NOuRqSkCyEE#Ht{UsCU5%L~^qoZOPYvDCWy)o7EEa>Z^i%Qj?t$L-KRm!m_'
    'cJ?$do@+IXp_?crH3%5Uq|jQy#5EAFZ8{t_rpv`gSb~qK%j1?NgVJ>iGi*+OwjU&>fvwn-V<4}?vzBVsBLV4cS;$EZ;`#J?HXba9'
    'wrHQJv%8Eu4Mm44HU>9^<$knvayDdL@t{xVbDv!St1D8lBRn}a0Gcr7&^3J2!;qEoxh9rRP9}ro=4v`dSNHKa*?!t866npC(mWSe'
    'czaD4+8uEfoFFFJas5G$jMToc!>)0QE7VnDOc3iZfF?O1_HD`td}%xJweKo&!i#W>x`^#0eS3KP3cg9pGnKNKho#Ot@QvCLx>L9!'
    'd&MVlA50Zi4~X7F-b>4Pds;ILw`;hYu4D!=%bW_1yAk%x*qcIBU4Bxl+psS!fk%dUU5;+WsK1&_o=Fj(;ztessG*C{5W+WnEGjtX'
    '7JM;Ra7EY^BYLN}`bTF+Zw^npAke+8XHF@L!YB~O2d_`x*sw*a<9wTPtF$)l`3#703a=VWLJg{<;qXeSP4FPd>||lOp2D=DIIg$M'
    '#j?*B6R5%fy3M3Ntxnx`uGL9?N?HuE1!Zj310XP*s@lWl1fzM%k$Y$GJ)B@<IjkAx-q|WT?WVsWa-}n8nYI^{U9k|E3~*KCbN7!q'
    'bT&O;g3~3C+X7>P%$CB)Kk`N=;-@?3o6?hA5qBdnLVLq((8^pm8?A(^eObNCK31u>PnZ-d;7(UIf8G01Yc<JBXWLSFqZaN9MeZk!'
    'V@WFi<1eOfznL;aAO7w1_Udav3b=P?CvVAwi#R?;9hW7*6`<CSRP9;9+BuY{N!;@7$6W7A+`6bCxthboEenePV_6>(tt<m{H3Dvs'
    'j5(->NK}VVhyw?ioZ%=#eLw*O@OdDdCvlBLhm=}vN{C0~TOeUHl&#vR5}s>)_LhaSvY}BRZbrA8-q(VFbkT@FA&E1}_QBI6Xx74g'
    'zMW3TTQ|M=HTz9XN=9-F(J)MrV=_->SA@v~eg2xrr5nLSDwfyRJq|_wmV4d1vdj1G|IiiAI?+5Kr`fV1Gs@sZdC=92Km`-9($1_m'
    '5eXdRfRZ@OK<QRmrO#p(*44tW<}OsrSAG3$_rxmgF5Cz}y^?}O)B+5OCPM2uJw)d2ay-Jl3O`FiA!qNphLe$TA3W_9|6>d4Qu`(W'
    '{(P&f;_^hEBHi-mAd+_kjTnJFQF`Pmx9A1UuOG%D=ZAQCxaaYzY1Hpzu#VngEA3v;REcI!${Cej#N#DhNsbD>hF!9}tvTuNgj0$&'
    '7%Zt52IcEhgRY}qHC)<Qc%*)oCB{2--Q0K<PW!#;<=ug~trHd*`w+1$s7TyNv-0V47EtGu32h1&03E{EDxyRe4k8kJH07na5LG9='
    'CXFhUqo>{!vKuq<_iTQoa*q9RjR{yCtkE2})7pJ%<l@U7BYLB-U9$TT=5`V3wN>GAk(5q(iJX>4tGaZ{?t@k{&fnPa++jycrDPO$'
    'Yp7NF;aqcY%b{Bs54r3+K#UUXxEnISm-W?Hp27O~Z>KLE*Z)QA_c!OMjg(6}{NeP5(i+&7fN6w(S$*LYuRAqz9Jj62#C2~}sV(i+'
    '86^+sI&BgB8~9ZE%}PalBHi#x=(E)qS${bLCavf59M*#1vfKkoxr|lU{p12X<(Urlx6w?gIdeuH_XHr0Mb^75H4#n4wGH?X80b+^'
    'EQwpFU^9$5EzXv#<!J6oURxoTpZt`YTR!5*CH&aA;jB99p-b|UdYP;cpQ37b*LQYZI-+aj0DuVa_Ki?6>Bh4dEz+BEedRM;Kkbi-'
    '*|Z>UBGK>Bs>|(W8raOvQ?h&M_k3c@=XAI>=uEnIMHMz1pNF__rByZ?zmze~I9$|yTe4{uQoS^F&um(iZ?bf_tMh}#fAt!_wHnWw'
    '-A3n8nz^;tzpZ*>5#8QJi|Dl%i+`VrfI_>rgVZ~Cv}tA65~NL*fx#qn;sL4h`T}Gz%#CSJ!q`5*uPM|sK9bTl@f~u6o4EMuAc~}0'
    'Se4_+$I-#xwz$={T)FkP?zyBnp3p>Y;rWb#1boamr$-wX<&H!Hl(jELtZ<G=2Z76x@xAYmI<dcEZs`($>MK+yY}&S%0xU;tgdVM@'
    'X6BF8a;D;{7fpXwTZPu1d5X0x36b74N}>|g-JL4FIJ&_6V%!aCXTQz{0<hlf(&^Cc21>5VE2%UjVywmPx|QOu)KB#-mLhx;Uh5@y'
    'rzuV*RZ?b}jqe3IOybTI&pjyYaL)I-Umb3Od~T|FiF*P2%Zy_M&biURo;IfQ21*qb+=-k1%5+=0gDaQ5JbCl>_2JoJN{*DJfoW_@'
    's1R@}Au}Lqo!$~M_1VGEF$V7@>A~yM!-H4<=$76^)`0Rtm7AB`7-rf$Rq;ItK1$ZooJRKYfO3c3bLl*f(Rigw8Rn9e3P0r~eXnt('
    'q7uHPQMwdS-CAv3mw6G#S%^;@Iy|^o;Ho^rHFWiTEJY&gNh!k+td%beJS-8cMWFnUnLyrCF*H3JU+Jz9fFR-%Fo2Uegj<Ya1#*0K'
    'ipbKKtL84a{+y2SXR^wZ&j?QBR0>b@<wb7}EdHEb2tB}zm#<IWzj|?a{PNfCi-XhCBWRPnPAYB04%8-8q!^n>_vtSOXNQPkmg?mV'
    '1y=YsI5kQCFq7SUh5w5bTjewXO|BalMJ7mtRknR+lErX~LI*}3^v0$85mh$1^=vtJyjnW-E%S&ZP2B=x5=1p{fKj-5eJ^xryS4lD'
    '$^M>iXp6fI%O|d^hb{P?!RqK+G84f=0o6js4~!VIDE1D=*&TctTrMf!m;+`xGd@}+jMpY6c`OLquLk3%;ApO(5kR{d0Se}IKKio$'
    'd)$l-F6>tj^_I|afy}QUS|mtv1zq8L(vAln%P;GjkO&_!?gXrLLUNMLNKI*ny0;wQ1$kcy#3Oy&f*gh5G;)E7@_+<b6<q5394IjC'
    '^fiZLpu(hMompVA246Bh4rz}AGl{-CHJ-5Z6yM-w)b=v_CM0WZ;mdPoQ9Gslk4{pDt+aWGGFlkdRT8SX|0ex7>92uaY!z98C<tNj'
    'P0cqrny-nQT^nz}b0!|06Lz|?Q_54rnq3xtS;nr1nU83Cl^LqZ#3ICa71f}=NIs(l-i|fwWHm5yQfh#3wGHIkxu$bXz)J$QYXHDy'
    'dXzTOM}*dhpH_7&cI=+MKX#8?s(q8)M5ExogcQk6o#oSkR$Ff0hU$x&RGN>6Ea5=Vs{TvGc>k*IgRp^JEsV-f1}zw#(7$(^j7oU}'
    'ZfWiLz+Zx#g}5rPn_!W|{gB*(v8%5R&JMb756*t|iGaeZ=(F-gB`)lQSsY=SV(xI(70%<54wA88+KH<mr4;E8#vJsrm=a?o2}0D^'
    'yVYARrUf*E_bD2QJq~F$k{Al(*k=!&F2%56SYK^>=V{&N9cL1{pgnCzk=ra-tn=BAu!rKsNgnXyroI+UgDSxOmXqa|v|WyFQf@%O'
    's}h4=l}KoQ2#+^s&}5DyvqAfFCu%<_h3&g~4n*Dio*GI7SQCsdOtYY9Uqp5_Zj9dOpU*n=bt0O2r7BE}xTi*9H7zX=gr9U{bx4>3'
    '4#QQI&d7k$n38)r!fs__a`VXP@yuC{PJ9`P<%IwkG%0&xmy<x$q!D%~foJ)S(f_QOOsV;ss{TVKR)~SqYyo++0+d+U1?8hcZ1WYu'
    '6^}}UEX2w%A+z^pmCHvp)$JQ<Me8~iFWcFCgmNLSH+r|DGp-X}f&R&CdE}~$JDS|;e;`-RP5fWB{QKGRRetl|$Xb(@R7pdKA-qA!'
    'B2N}XWn!&9Cg6Y9(69Q0Q;lBJ#Q%s&!8oR_WX-6KCNXGk^*Z?orIIDGDI5lQwjqyP8Uj|xJI%1aq<E~CO##NFfF=OxLfsp#_A8uf'
    'GQN(P%hnCO$}OHcWm$3|1sQWLyqh{(5JRr7)79P&&SY_Zp5kh`=p&Gi69-2(qkn!qN<Vyn9ngeLN|U<MwyQnWx?@pxqCDfAG{G{`'
    'Q2;f3YA|D^<yMZ(REBGLk+!hES#ptXQ^(iDe|pVZ#;&Q3as38)0CInLg0#JjX2L`sN`+|bu9%b+V!`a5lEKE(K`0!QWCIZm?0{BF'
    '00C38Zb*EuHNugRd1@=Y=lIZ1K%yVLL1vy2S_jhg9@-ISHk2&ATSGk5+PP_{W8;VAjpy=_SJ;?hRYp45VO<EXf_p6daF2TJI6Fp~'
    '4b_-Z)J{W(HJWQ$i0V4ab=3_!vxbz|H;p%_!)n=ZJz%vWR?YGy;PSSsgK1YArZqUp9{Ox>bdi(97pNTIS~&vt^4fB2qcPVtv<pUk'
    '8q}Z96sU5ISQ+SRKd<z8D3z>mYVhv%4I6b`8T{L)RP>(OMEBFsjlnugIE7rVE4^^5^dgoJLQkfZY=AKH?bXhT!HRUlj>+z~yUD0;'
    '<BSN~%ahz2ZPW#4%^rz6MJ%gL`<wX)ta1);90JI=n(9^MdI9jCcisjyet%U?0gfoM(GFEn#}|_}`qURm*+^{C*^pLIdQ%ZwsKV+-'
    '5gaAab-nF*Gq3IdFNNe!I0HpR#$9AZF*WNr!zvgc!AtchszTG(MevZkxPnqx0RvakxDpGX$jpn{-K)*+zRg@6^d#pH<&R0*3LF6f'
    'f$`L9p^DO31=z#>q*X)_z?Pi;VexqD!sWg>gu&qmXkv{~GcFl9&Q>cK<I#k~WD|5_H><8={r8TmP;O~TL5pyhv{v`fIX<Y>!i%)H'
    '5D>6S3VwDvTMkU*HYG4oe?$TkHwaFw3Q#OhV=NNnJ~4{l7N__v@g^Hbm;}BQ72zhlWlNAT>jDGr5qsitek-F;`1p-D$<s~2Z+%wM'
    'SK=xED~@4uJ?JHte}@J$1jkcH80HFc_gcby!t9sEe7ch=nEqQ|7fcfm!TDblToa8b2?A!ebc;32Vx?Pr^8}QII~YWJ)>zl-mFc2>'
    'kHw2y+q4Oool5Gd#}tGWYIfmO<V$~~%ynw^F5d;Ix`!*hg^rF7PtVj@NVr-xiHISZ;D5tzu5=o5OkY?|(_yi#;Px)&>Q|*}_L)9I'
    'DAkJREKxmsgtPs2Z>H5if4_@o)3<tM+_$<lhV~7s``vx8{uqBOkINAH9!;(W^U*>b280f-2NApX_xK~nkK&abwSLKQhh!C3x?}>('
    '&B?d2Qr@KUiFbs=L}X@@=raCRC(wI(J^Pp9|EPE9e-}!D%a?vDN`V0>(8|_;6l?;~`E4He8<6e8fO7dN@F<f=uI<6v6ax?g7lnnN'
    'f*YwoxX`{Au1^r5Hbx(6wZKXkHcA<#Syj|b4kll<K8vt}#ef6;jEY%e<`e24G&dd$7wVHTr4UWj$16e=Ys<yfij@>}DVE}y$$^{;'
    'q#jBsKZ^mB%A0#&lXANic%)n%1#D0+{9K<wKsFWGN}IwOqAdD|e;KnZ5nY!kbVK1<zZ-lWO_xPCCYgVi%-x%_B&fu<Wfb(By%j%o'
    'TyuOGeI-<u%*Qpm;h0e55b%VFiWW@a(J-q-V?+SdZ9%Zb9fA6H{EMPvO+XTAk;Spk$*@VoT15tSbiSWbNFF*buDCO0eoOXQlkWfS'
    ')!<8Qd(RCNk&Nt|=Z1SEmZF9xpY_t!rkTa_b&{Qi-V9wUT)BrsjYN0%iM^A2w<^CDVOOzO=vfsV0Ds<)&#MREH&gfUw-+p4*uvGo'
    '9DbLq2F;7D;=n2g#KTkVlNp*4mGIJqb+Tx#a2uSa2+E@JG`1cXA<KD15+|`pSn1VZ42P{>TSOJxrN7}aw!!{cvb+6k_i<~t6rIfG'
    'a1p}%s=d^p#sXfyTT73;7~wMV(^a|%=Oi<#s>DENsS`h+bP?z*lFgO^m>24yx*klH|EN+Y#i}IS6msM}G7WsU>Pqn;dKa)p%f%q7'
    'x%yM`*4~&<bjt3Ucy9ISSTh%=1JOmQxn^=qhg`4UcdJ9hM;I!c6j%Y8A1`{at8Xx&JV_DUDXe+|bU}<co#t{$G+ky9^@4n8;9MIV'
    's_<6GHoBCo+ggPcMqB%ds6waDERrk%E)anT*?IfJRe`2&fjXo&8=+m~YTC~vnZU)g|5Z3HQl#b~0Mxq4mGA0}_|^N}(-#WaCUMP%'
    'OBiT<5PgXDP9?MO9gtu+FWf(839@9TRmuVr57_TbiW_2kFoSt~t*kF6Hn!7p*Lo9mL<z;<$LMOpf}l+(Ie2>{f<ZiNmqZ5cb|g3V'
    'I5x;{m{*?Dhzw(w)0<(=um$tzvjv>?de$QZasO2*vTs!h5s<?YxWTaU+Uku2cP**grI(r0t*qRStlV%I@1YSYNHFOyhi7Oz-jc__'
    'sXrnfg8Rga>sMe5(cbrh9Ri;d&r$vPN;{RNX17W&=dBuB>E#*~P4KCkx?H_6>)&6~=(_h2u|kHXGB33aV~Nljhr8i&NatdtTcp$s'
    'RG&5pQ_y}N8}=TtdqnV1dr!^>EA%@)a|eB_mufO2rhcl+3MNe~!H<+zTE=nSYVUN|RS`*ztm~Y=3q)I6YNvD0wJ~4rb{zeoU+L~f'
    'm3m_)-0QT?uBO6AY2@|{y<@HMIo+gkrenK;I1`Av629v#7SIjY#`o}P32<zjR5Mj@3S}MtP?Ye%do#c|>-Yr<zm0OkO3yljuBa8E'
    'TP9lc7V{~3!!w#OidaE(%O-1VDwU9=I=Z(P3kz%n1#G+$ho{}U1ux)f^J60X()H0X%N)c}D;uMSQpxDy>b2TYd>`|gc5Gl;8DkYg'
    '-(>Sc%w&UF1XGagFB{ofVm8eUquxuM^+xR8tw1UfNxbqd&Z3vE^pqNoR}_~8ZCwqnzFNAEi1n4*%uHM!8$cvBw!+3oA!Nk9RL_#('
    'Z}b?96p4<VPmzXX(5oExt*e31JKWPkpl8>{_XC-ygxS%9jOSxZ+$Xo_9;%uWk8j(oZ&ACc6!$qc;>EhvcH%(Y)ZTy;0)<tc2imB6'
    'SbVFtPlYmTHT=-M;47TXwjoB)caeQLQt*EM1Qe<%+N%wY_6im5249BxGuR^qGkkQi#Qcz49vwG@#=0w>Q;x6-IWkKnLbb1~3_$Wn'
    'Gzk4%_#R@^41crEL4fOve{0z!O8!^5v@1I90vfr1IF+b1_sif{F?7T6Ar<J)kfBGjQJ(l3N69N!OF1<(*&k<ff&r`Bmy{@4-;pl1'
    'UayKPO=n+0!k;`&8b?XvUD9}wG%l0$QE>&t+5FdXx<DU|{#s8HVwAX2s}{vD<b4pJGf}CUW-;erI9}2Yp^wn?rrxfU^j+Z&O1grb'
    'L8qe>+f4V>X|}8Pf>)PuK@>LGf6MxA_8rGRS6AwHook?E-gQT~pp1wJ<9WfsqgeOjy$yS->A>l$^Ny8POo<>pcu6fJs&9&aE+nEB'
    ')iaM<7MZ=IXj^*^`?a#V4d!Aw9F8u@ZH~#qXx@xQDUEec)Ke<NptnsIIS9WQbC*a2@^$Y^SAH;0k`rm(1Az-`fU{yYofHG9LK0@0'
    'I8Pwp9R7dZd_;6$R{zC%FCJ-J^Hol81N(+PsGF^J@bWK}5?Y)!v-_i(FXKk)-*jf1LvJ=M7U&suG5D@yyTWb;7eX^`ZK+@{C4jQp'
    'a`ip`Gnx{_f+G&}e5X@lT<r~H-OxKFn<;H~RFS<sc^A{MJxaI888M>pk?=y-4rB=~q{c_jTEXX>Vi<c919|oDez&Q(ICdX?z(|GV'
    'tmLG{#;((8MyJ${=xsA^z>)Ln`x%54jDaBj4#h9klARSJ*4hh2PNFYDI(F-?bl*k2w21O};)w&VdIjX{8tr2f=c|#7EAWctE3a2#'
    'G|f@{=k>O-a^A7-cVZh=mu}x~oL5?ns~YeO#ku3dDeasGrsPg#O%dyGzQQ(KkHS{2J9H~@Ry*ZQN238qYwNFno3ldT4(ELqUz^ZD'
    'Vddc}#Nw!zb8~7M5)-nP*5v);jz6ON2(3D~rEfNy<2Cx6`r6GdlUjLQ2{`J1ugjx<-1*R(I>+MNgKVa_0*wmtnXi{*+*M-@iTzK>'
    't5NUc1lWYprAd*ad%O@=B_QkG4BhJ%Q_eGixf&GAa}!Qs$dl33icOyuUlszUBd(mfm(Sb8?{&(VkK+c%-`QC+^iGR-ZFYa(3{!rc'
    '8@O<KzN_eS;pCq}mc9ma|G7;Hb_}ru@uu+;E@9jF9b$p=HoLl<e|W&i6oRz%;X$XI42+LsDM9t0Z?|=cX1#eq_H1}ge>V^2AD8G%'
    '{g&R;Ff3?3qAb^Wx7(jycDoq{Bwl0gq`A2DnvYL=H?Qmmzruy_vljIlL~QPEPg<&dc+hC5_UOZdjBt|kw`5S)M15{dQdJe?tcl;>'
    '=OY^nf8Q^eWB7&-C3dC(=YTibHJ^=&DGELfj13)K4hsAhgm+w+4-XIkYS3LEJN#h91%g*NlpcJ+gc7607@c9S(Lrc3SfB@aqLr&l'
    '42i>u^jKmUsVzKGuGvp@42!0CL9CN;hH$-HEOFO^6nZ&c7I-~<oKKeqUI4!+j}><Ea6I~WwP;{$Y2`>))*&5j=<(GM+x$0GCMTqg'
    'yBbYq%f&aWfvmt}O5q^DFwV*2rA^LK)-~D9ZHB><sGpo01Ghxf@v5xp`DE~A0p$m?Z|*Cl&ct<S<9RoctVI@=ScpS)R~W6_n?!n@'
    'V6RPYtH|8>uHlUKJE$FlrWceFFX<)!TK48W#1e&Wu_6GWoq4`7AX{^9@k_S{bQLEWb6xqr4-aZGfUjL~+Rb|xn0~kZTrXPkM@J{R'
    '0V=en9}RpJ(F4rlXox-2ye(MQ+IhR_jbNQwwPTKz5$1)0yQK##MgG`09#_>-0EK^N6_Qe~;`=A^HGERobAtZCY6`lZ;$hfy^A$}b'
    '=Pr_S9KF%J#+r(H`FkgDvBG>Oog&sIJg?btoR505B5w7{N$Ik6`J9M%RtxJ+H&K=RQ8)w}{z2rA1kFWE>*kdld1{I!KUJyRtyMT>'
    'VU%O6E^YYQ5U75+v%h<ZaKY%T+D>k%<Q*<E^7=V~WEKk`-+8&mhkrjh!zjA<?+#xvy8|88@E_!3K0N4lDgM0s;ei4MlKbnsudtTa'
    'hhIjE8gWP1is4|Op$FLmCr(3$z1M0XKoSOb%)UNoKlsxRTgzg;1rpX41~iI7ANoNU3Wr~SJ3&nZ<B&{;1kd2ql`udIWofgxr<7h3'
    'F;BPt`X>1VVh?<VBFW`oJmz2(g=mm)7-f<&jQ!i&&0wk~)9mAKqgi&<E3U?)iwsYg>>3%LX_0{#BA)#j85=TYM>CW<GK(jf!JK5c'
    '=WrP^WI#VmC{HJL6?OyEs{uLk1kRV<NAw1yV(7T&ltD)1!{qGX-CuCU@^t(0)BWCHul01We>uE(I(R&6^`7qU^?SX+vz^wn$HOPB'
    '#}~VMPg42l_~6aqyY9PR5At*mzS@7>dp2n8T<%>y*?YRvd-injtk-Jw`>pNAk1roT+wE=d^)KOc=<o0BU0hy3-Orxx54SI#JR4$_'
    '2XEiz>7@60)VR5VMHtK*<K-7-^x!S0w5Mcoec-uaNsi!L?GF%E8H#*OG`xXCTM~-IE`J5rOFJ0=?<aZp@Wh+^iElRj2<emZdE-+>'
    'B}<Fs|G+2QhXxT}g1iO;|3KTt|G~1;Ay!xW@#6@YbByfyY0IHh>@yW^{zyIlsX3gHkpmW{&o>gKS!EX$>KcgG4bDi4EE~vsgy!3%'
    'DVWX>i5qitDBr}vrUm<Mn-Q_7nPGLKLh;o&QVN@+uB3(F-JoBzok|)L<6<orc)jr_Fclz6{_WuOP4~^g%U_R<4~YWuG#u<=y9N8R'
    '-+20@w?EjqOoNY(Ughc2K_97M|H)wR?8#Ft@z;~r@86Vb?Lvic&h@)Ng{OzV9Gx8JDP|XuN3RawzJuql56+JM3UxGLP2y{jJ}M35'
    'Q3@-g6&)S__3-%Y<n$lwYSRe^E)j#;rXX;~>n7>`!-S-$<drC#YcJq{IHaQ)RmANXyi^%+G8pu0pR;Sy2uKv#=QbafR=ZKVu5)qJ'
    '$z0Uiat_Ne(`2O$yl7qxzOXA{O+H}QQ>uMNLJ9n6YPdnI{+!yMnII8F3cD1*h&-QV=}glQt5$-pvc$``PUH<j@URbbJE_56^zRG~'
    'z2-^x^wr7n>wo;4{yskW`Q-KMlfUV&;}@?_UjC(?rSprl4!6~iE{h_^%J5jM4V$<tCevD7x{6Pm@483tfG%oyLv@i$u9J-we=SG-'
    'JZI?X!4jdTRV`!6{zq%t+TTyi7ZX^bPkFv=pP;e!$L+m`+pV2l`VS%I(db=xpE>PVXDXg6EH?o+*GyfHwsrM-FvYX%GcCuwcazsh'
    'E!$sS&k7&{OvKauH27MuvYKH$CcOzOoa-SB<?~@b59a!Br*^Jio*o{Y@t=o(fBD*9fUGs$W7aQNykS2}Z*(z+%^M8NCRE$!uoNKg'
    'T|v9FI$tN3?&?5IZg(`gx<mo5j!q9>;+DfNkR!B}kuQkql#EV=9y1cu9I03E%ZV5$`WT<Ud53b0IE(zWouv!_hl22Q(m<!Z<n7Tb'
    'pKL$p9=5lE_7-ICO7v|He4DBA^LeZDL!SOunx(%@uP;X8HA>A0QKZ-ktB>00Bd6spxbL?<0mm{JZ-FG!pI&dFC7fJUy*>zv-=h@1'
    '|BO)GJTFWRUA{zEPYY{yogsX@ohm#y=t-XA+w;^YdesI`Zv(QIn+bhv2#r4CP~>K)pAW{Yutpw4+VP&HolKP2ekU>-1aQoGiu_Z9'
    'IjWS#kn@k`#on$^J{BQ#QaH5=>UVaHd{W-3ThK%3+kb}q5s?vN7YX<|C&-+R`}roZEzd;{nXikHea<-Lq4to81zH0F%JWuc!`gad'
    '&X7yYIGiNXJBm0_^FDsp>eS(q;J-)+Q0Z>sgrM07G`>g7J(LcVHFn_skG4+yu(OpqS#AM3xPfj}r&xCSSH!*JDTu38f7Fq(LjZP6'
    'y$@3NY@j=0gZ5jto6)hjT4gh<?M-TS1OEB5DpfHlia$(%e?EQH{rTwd^{aRJZAu8wa9CWTr!)M^NYnDK+F<x+m&#%;VS-qPe@NZd'
    '6?jPfxtK0`WAjV2)Ll5o?vOb=A<hHVof%FH+V3ZfL)c6XNSOhfyf=|BX-8CIv~7e7fP(_7GTJwz)!^Fb9uc*G222&nrvdO`P6i2J'
    '`hj~QhJtJpO`V#Pw`aiS9lWN=8P0ozTm~%HxKH4<+*B|#(hB?>><pY=^b!LsVC=6Be?EBs`m9T`46fkG`?Gv|r`5u-yprx3c3bxW'
    'ObQPRnCGi0jPdO7^i48Et0MB&6sDWZ;5uZ*4^Ar9*JwaT8q$%ZhHx&g4i8?v1_qI%D~;X=sB1ZcT>(=*9L#y1VD3j!8BB}&asFhN'
    'JB+dcG{MoG>_=B5AP^WBL4+h*P|~y6*AypRaCu;P;AXkePgr+`sLn=6BF2y38(bbSlNapF1>b#~_xgim+(V}(`kdtvt{f-LOodVc'
    '^%gZJ3{8gz7O)1I`uK)&9VE3wAhYD%5-tT6nZ&qO)SFn>p=h_MGQm=0N<}mq&F6+)c<zRLCd)#F8WZ>k>jIr-*fy&BKxYn7C4zCc'
    'QT*@CziwG648|~Be!Sv_rC3ti-)YsE90<${>tz%^xSx{RGhnou$=fL$@d*KHCEH1Dr?s=!01*nmgq>HAzwY+qC#~jQLc8MZ;PmYM'
    '+wK8!YX`?K4|8bb(K9B4lgU6=n3Vju)kd%|go<%v7MoYd3<l;EF*wkK$&}K&{KUZRy(M`;03{6O*W|>Zt`D^G|HSEPCNBi_PXuU0'
    'wZ~{<=!eXcm`59nX+x)m*O5eLoTTT$G|XGA$BlosT2FTEB<#0#6PQR;Wtdu~$^0_87<`=y9YS3#C?s_EVe<0i?LT0PAHDYHi-^Y^'
    '2`!r_ueEZeW2Eb1;cS`O?$eeG0O=4!#KVJkhfWK-7$}aeNqoB47m@BfDt-Q8a=7ExR$B2#k*aY-ucs4~@Cb8-5tG7QPRoPG7be-&'
    'v#ocD0w~bq4jgIAIqa?E0ITCG!9Th%1rYKI6AmyhosS6~UQ<4>i0-kJ-Ow;wZw~(MpSk;V=Hg@TWDCnZ@+L*kJUW9ZAJGj`PJjB*'
    '*IMXV?HtoWr3Nk!+i&1GnvnM85*B~5M8wTGyr=t3)E^Vl3E?)P+9)bX3irl0y{`pnm^kUmhY10S{q5lF<*%<!e(AnBIQ`}5INyGX'
    'V?~Ax``pz&tD|Pkxvq%+WW}NbtVOlTjC9|z1xD{#n2SN>rS!<D+Cs{jV2m%`o%ATy`OK*yT0q1xIpDia@tS)pI|Dn5kx&N23LBH6'
    '6ku@SNe=e_s$lUF;9Ex=k$Kbh*N!c7`{EN7a?m6>dfgQfl9+0@B2k0tVvyDw*pyn@;3O$#%Pe6<E(Xb7tJ(Z>U-|N+27l9bd!86A'
    'BWyM^NeSghg9%!q*&g=P<<%4yxR=0YLZ=V2x3wYkNJ*zs7UeMd{N?K-WGcwM815;`F-tc5Vr!jtJ+1$_7Ji?F54N@*v-W_!94vE2'
    'Q(74P6h5hu)}r~(DM&K>Hq>KCJ*a5wqS~%Ys!38h_%!6GY^Re!gASrlqlpf!{lONS1W;lC!H;Ynz{4`zMrs~~$uVTa%y15kssx$#'
    'ip$Xm*=~+9NKG;o6c$|9_TEiK%&cVXr5uYS=Ac;36@%ElYjO%#pa<_EdNA?Zb=vXtC$1e=ao*nPMA3)08_zmeN#|jjNzr)8&qaV*'
    'E~OtkNxxFozK42ZaV0}Tib?0eZ;aUJDgtl~a;d%5$#^yN!8VBdxDq)huhI@@x+uBr7E{J-H0cs`Xo;FAI}qKGRqPI>yoDL_)c(xg'
    'VyVm=L)IaIvd4HMq9i=e#lArKgK?o9TA{TqYockJaXT2VdxepBm&ODTomNjDWyT-w1g_$|++qh^&gHArP@SEe5@6%I<Ab;Femyzs'
    '9=%G<d;@LjpIK_|OYFqfxQ8ynFl%%IiQ1=~RMf~+ppBnbHQX`HS*o#5M9V$zcU6q5(a+#4U{gO`7_5|PdyD`xHM1op#nFloE00P!'
    'QYg@tE1KCw9!WRUsEprQ$x;J*sfZqTYGk8f4Rd;TZolcU?!!Gfpik>C#dlk9DnLOkH2fjgb~1w`&cmhI!2GYZ$RLqJpaYi}cpB~H'
    'pziKm_!2pzpE=PfN{DpsF%Tyip9bX0!dbLY50d<qfh@!!QBZ==^9!N<V41K!5{X2$h4QlalUQS3gB&Ng`)%BCy+sdwD2mbbk`zJW'
    'QJwtl&98NmQgEEYi=nDiq=kiNJ9KP?lf<zk0nhgH>EXLyyQq`yzI}c0^6<^!@mWsimP4^zh@;Mo5o*-yr&+0xShU_BAN_yt54-<$'
    '0&HzMM3sG7cj;NjLxf$_Fjrm{BW<PO(mc?2DDE4jgIV$nZT%z>%WU`hteenE(DG4KQ@4^Z-Cc%w!!4-h0<}&z&jx5@2GQ@8!L`GK'
    'b@U}q>5B$6+epdl7FZCZZBpMM4QS%D8mqm;3m8EXdhBmsc+Rq<GM73s0=!`BggCiYC1gBLKaNl-)M!jlEG3d|OfUWk-9=?u<0WhU'
    'aWzo&e>J_K?e-{ble}DPnS@*zbb{@6*!PpNh+>vb*v^CbqSnex3Jt1kD;1tg{Gm|=%65Ef^VHQ5TRrR^Nt`DN_viEJO_7%#*SxuK'
    'r>~wlrw*bw&}56=)byBr1Zyk%s{}!zd2WV0;LS0GD|C#gh~`dW?QW*?ai5HAWBM<wJD!@rIT15kgPSH*YEC=u-Y_Q(-W>6*5j~fd'
    'lQHU8%+Ze~Q52Peqs7}oNzEXK@@_HJ)k|W<?VZ^wEA}t*eRP7v&K5ZZE_>Ir-ss~*MUKJ~K=PQT(iO&XS1JjP47u(q6#{s5C^#H<'
    'LUdpmU1BV&1Po54h=i5xwSLUqcR!W{`79<j)xFAHG1#fwliVUYkRP4zxLr^1O9NHLlEQF5i;jnLQp-D1UHrMv5+;ZWTSg~@v#AzD'
    '(utzNV}#I2q(&MsSBamN1l#n_wMeJ4u%GTGb4Tnhx$F>bzpD*&iF>Zmf3vDj9Rhg`G+UIEx|)?nk^V{oIG*&vN*kt-w7I>RrIgh)'
    '?RCfwx1_0PxF2~epw?;+1JQnJs7RugL*yKI8<6;b7aNUmBA%j*Zn%J5IwXy|VHwQeNZx8X22)KD<ry35KSXybi<R~p*CGL*_!L?)'
    'll10;2zTZ(XXS~m>R=Y@p4<!NzGWdz+R0bJo?FWFX9c&ybB}IDsKnL6ZFa;J{XLX5Jh(V+S$QMIgfj-3)Af=i$oEk*=Zg!6k9DkN'
    'vq|{AkO(0tR&L5;`Ee9fTDWoBgODjVW-@fvNn;(<5}8F|G9RhRz$w14V_{x;!8vPXb&Ne9b3vM?aP#6bzm%uBF|TsQoU<AMe`PtT'
    't@h6duy{?Dr_4+jU659|TvM4t_hL{YT`HM21M6T(I5fs0VUV?8#(jA5XLJZf0;K9vWJ^ItT#m6fXhUV;saVeNY%Hd#3r0gpnLThQ'
    'vt+ew)EdHzxfa^a))rz@1}Y?{9=C8kgF8{Ui&afMZux@7Rc|&ZP0YK&c!(hr1yC8Dimnm(xeUnHrUPe6N9;eR7YSLa0}de^KxUyS'
    'TzmJAIg%oG=f~WA^Kakwn=yKY*E63e$QGVaUoy0YlN?Z}q|H|Kj<UdPTsJ?-dfo~6V;u_aG2%(SC?|qD>kEk|VWV{(B5*+T=0|$N'
    'XA8XjDc`n7fXG-_Y>SF*Q7>Yr0H=?(M*t_N-gy60aewpkBiZ@<Bg5R7i_yePGK-Yn9NXLP-1kT5<awyj<yuP$-7K}W)4At)42eU7'
    'ryo%#hq8`D-ef*RojmmhXC{jla^$j<qo48?&D99!N<a2yOCL&=`qP;)8jU=s%2*xZ47EIu;TAdfy*D})_tHFd6t(uxZnNF!+_tjq'
    'oqf2iq7~MC;={NXe4mV*PSO0t&L(%tV()))X8R#ha%IUs<6ClZ;^z5ib$D^qP3Z1m(Ihcj<4?&;l~VBNIeNtm()<=m+%^7ri+P6{'
    '+x3SxqyFOR5v|Ch?YsY<yf@)$Bg+zm|4L-#sSe2w2?;RRQbm44+N4dV4GiF{s+M(Pw1Uz?QY(aQ(&PU=?{4qi7mFmEboG2^dU2wN'
    '7jM1q?n~RA4I7Frk`J(9@Oge`_(F)AoD3bGhqvo*#h4nGm;)OUxap@gy=Mj^g)VvF#9rshHHU$nj)UV$Cjfe@Xgr<wER_ZwLkcCg'
    'SFRoHJpK5oQF7><d=mVxgjmGusHmEcedS4J^3X$a*q4Fhy8(ucIl6><P{hZ#%d|^ORx?mWw9TfR!PezW>5<cH8QxPkjr7j2mMftB'
    'PI+b-k4h;+dN(7U&`~}Ek&L=LI@?~)Gq=|wJ%ssxXHYkXmT|DKu6p(cTu<kHGezv+8yc@M^a0^=fN~yb|Lh8}Wd`QU8N$xQ;Cdo1'
    'lL*PnACrZ}#2F0}CmH7T#VH06D*UMljTlJ_4`yW*8IJu$IUB;Xc&oAm%Db?C^LgASKH>K;5d=z&hH1f=n)!sY&ggC+Sc&YIWW=J~'
    'aMf~hidA5vtuc@cphRJS=+JNT0Q^}Pmu_P*jWbe5^dQ#S>h_>&*-aRU;%~=Vs8L^PuJkBPYb>m$^33pfHP$8IBU|5RaBqGeG#c>q'
    'qxokKUt?L78sZ4^yNS=7s~&jbg&CEN`3-&=_Az6*n!%W;V#R&0Qr}~i0Kppa1UHK=Q*QR?A}5}26pBN^G6DF7;AVZ?1FIb9wcFxt'
    'fqel5hZ;n3v9w2w;gb0-PAAyENIYnM6Le9Cy69-zW%`o15OXTU?8d`edr+{EFt;il7X0+COLgPf!6%-2Fn5f2SV{x5<$)Fwhv<oq'
    'c0BDd>Wr018249Fp<-B~R)>wQdxQI+GMfjiy%pKVb>WIwT2O!@8Vo*;f>>=TBk3(HEN+kwSbZ>N&v|*uL^#6^YF`Z}n|}CEw+f8i'
    '{cq+c*--qYTd~T1=hC604aP$bfb>6(?#VEtOkGFk=Qh~s<?+c|EC%P9c#SM~{3>~Q{yuqq_S^Br>DdLFZnB)PSf<S|)l$Wb^=dHu'
    '?lZ&ff<@VU(8cAjh;MbTc=_x)P<09VUBUt4s+6{Z@F|S>!JSvm?Dz8M-TBeU>(k`j`>P`mOOvBl?@lf+(frpWby=q6@jtH2YLDJZ'
    'Im9^JS=}ynFqCv@V0)*|aR@u%Q}1Lttr`#ljvA|WpN4gNUvoj}1p_1IJ2`!I{Ey?y*c=9tjN9G<EIUylr(tBXf{tEaoV`C!uFkHG'
    '-o^?O__D!PQ=*>GmC?Y$(N(@X&Hq*-{QTX~#jnYm_doO3(Cx{qxLCY#5E@zk7<>63s07NkA;2jpW3QSx#{UXSlD)jnzk$G{Eg(mq'
    'Dg8CvT`)vnqOUTc0t)etY(@a|jXXbjwZo;E!5;(-Gemu?{@UG2^hZ7+7hZ!MDS}FjcLCZuiTGGAT~0^9F02D5G)-pcu=?)o>Nt6O'
    '^xo`oybQz8hAwl&vV<v5<`k(sPYZ*QF{D`qA{Ry&b9A8#=<ZhAy%a2?!6KGOE4UYqpRJL5iCO7AWG2IFP`~~o<Z9(*L5Uw`j}&ki'
    'NW@`Dz#&h+B;=5lKrUi%_Zh`baco~f6rl8oDNlQ!!SP1kVsDvvPH3VdI^)>x?rxWN0b`+Fn}2?Rz%Q8ly#ISVnb&^?tN6(ocET&='
    'eU_Q&P%m?@)ZDnC9}QMCLuptt%RMv8PdfFSv~Pp)R0D-YmZ6);MvMLcxS!s5RJT?2;!I~b`~GtDsfI!O=GB|yqgO^Q0L)CVB@uQ8'
    'Pjt8(9XalNm=Ti|Loe1&Ugk@wZuH_llrzul9Q8r*edNGU&Fmt~!S-Zza9$v(xJds0I}o(3LqOY`0zZ3?61B;P(v!H&|Ef669>r-2'
    '*=GO}h9KNAhwQNgVYe;6rA{%`n#4%|Wd2d|QIQLFVdSUCq42lVq97Y-2o4w$16TvpLD@$!Toac{VVM$_#4(!=kwd!@Tn<_=BO%oc'
    'kK^|tkZZUb!0j*|ch~q^rYT+oBgbpB1MRcfSowQZCGl@&BdK^|_bCXEN+4#OV}q^o<<78Amz_o}wu}TJ#lt+YC6tI#empSxogEpO'
    '&!UPEjxuqk#r5Qg%S?DQ%02T!-QD9{%)HHI=yykv^E^Es-L(KJCc(wo6Kw-Q<OLw@@jpY-2s}*rYI#)iu0I{c)81`=Xautsk=NnK'
    '2z~I!WHyg1g^na40R3?-f8Z`emh$ok07uCzrC$U7RrME3qx0l}(9v(4y8DTMGsRU@Rf=<@_x`%KBl;!xiKgb#1WT4oU<4%FB_+c='
    '2YwNQ-0*j`l}RF8-;F4VaOM)#)CHr2hgb`z0Ix(LM{I-sTK<l_SZ)YL{;XoT*~^|52TpB<6pNn3Cf&n|1G!`vUiBZ9JSA{=t{elx'
    '1icvZ3_>K4^})QA;`lOrRghu&HZoOZ5TFiTbP2uBh9w7i-ZTJ7=u;<D)WBRkOf<m}_{9PFf=1+VokB!m11h;>C?TfP2zNsEg^-Ur'
    'B*#K)vw<)}Bo#>Qq>UybLfdR@+E^$fuy)KqmytJM*pdGMBnz8mgbysN6@Sw9@lkI%y-z4VxH*5gnh;qpv%oJ%%ONk(*2nEE7wWbY'
    'Dmry@F7;;@C$CS8^l!K*Ba8oXag-b%UA(0_8hT(uHE_reGt^+kmdwLWCs-Nai`hc$%h|?dlCs&$6k@etnUo=UMRD6|m<(n$e@~W1'
    '%zN@AvnXsPDUL6We>*w;`!Sg1k1vi4hn8HNosl3<Omx1%<=Oj-m&cf2D#JM!GzP83Wh~mmv|82#6iSdOB6B-vgG%}4g5FME9iLvE'
    'T>UdSKe~E@1Iyl5qb(1T&(1&vsrwnw$Wfw->CddPPp4ewh;7NbATD^6wn^%$f=F)_a(x5zVE8v&{{-@rt>yvC@h{I#uP)Bsf>N3L'
    'DT5(VB3WS19Cs(&LW_mwezRBHS=9}juYRsG(PY@y?`8bi^{Zrs<P4*43HdDPTS8jkO&5feu;s9i9xAjERHe0~NeQ%4G=C|yn&Fr8'
    '&vZelP<dRU>aEF6Kq;5VNIcB2Er4H(P(+GJP*TsU5og1V-R<v$zZjr)X}S=J$c4>aUkcQ6d_k1Ot?p(B9RYuFtj+XOla5Aa?wt;l'
    've}5dC|O~sZ|3EDv+ci~T%KJ7;ZwiAYJ_sBFb@DvHvp)JwE(<8`v$!HJ^guy>{`^x{6>u>O6RDYuDHclBS4&<DKP9p?i$E&iRv}J'
    's+R`kyga%n)VYlZv(?nk5~$Q~i_b&M6Np;4l01Ng>Nm>uH5eH}Tlo}a)GJ|?L}xmob+CYH2PqXoxq)<Zj0ZMoo*Vi)lECE~1Imm#'
    '`3Tr=PM$>v(^3N979!T;3Ro*My;~Bna^e-f`!5o&fX}$&T1o|SRfSTLQBHHrGlnjI=IQQkb`VrG#<;n-j{g>k2*o+turhIOt;AHi'
    '>)#_q(To&F3>bYhHE<H+<cPD}tagq>fg62oz(qtf`gzv7t%S=t1as9FpJDU9MU;=t-KY%Gm*MjYJ$a*rxa~v@+oytKVvvX4Nvsh*'
    'xOp|JUJ)k&t*Di@a*ozB#JlrFNT5JB<327?(Xj5QP%}gOhXe7RIf<p*lbgOG>b?T2ecbutTsqx^d}#@8;FpamGXzF%mX*p)YZ_W@'
    '1<$~`Cw|E(*y4DNI*s}x?HLW7*RRAe57KFL^Kae4xfNyk`eU^AE7@jpPcyBxCs^Zexg?2bRlS?7Vr=|$Z};%vu)4DY|9#$e8hX5q'
    'm2k~cS$H=mPWi#%TtG~l_c8NNZE$lp1OF2FZ5Wbkh~8q+9c`TeFYFHNtplI=3(;P@7^jC(tg)T3ne1O1&xYY&>D#usO4o+j!Wwa~'
    'wg{G6!<SF+0cL+Q<Su;q=KblfA!ip;%Q45Dn>!Ju`FNa;5ZLLj%<So*o<2SK>uzKJc^o%nMfCJ<G*i-U<`*SHr!~DiyILMgFBe9M'
    '=yy$C^HPnt^cq6lLWy()3V{fTMviE!zG^KamF!}*RZeTw()k2<l%t<7VGON9c0_?Dww*!+*f@Y9PnkxAT4FUI{u>cMkry}>!IMEH'
    'nc;@<B*7eYsy3@7g=gfn^~ozoEozp#77C7FtM3Vjyxre?+gL4+P#k?-NA@1~xVG1S(qC#j^cYyQG~{z3=7rA0;S$&o3;22A6=;N8'
    ')G><Yv?R*Y8>H^q2ty*b(!D6=V(oiz*Ckfch`?Dxa=Km-pXPM%&I~AOFwI#%8u_KLWo6K_jQ4k#7|S-=5_Bs&$OX$Fj2IHMaGKo$'
    '=|I^mnMGpONLeq1<II{cvz#afPW$Wrvnmb$_JSf>NSP%AQ3!i+YZ%~1qGnrAs|^GXH$rH|78InA-u=ty90u9*v<mNfu;I2t`f1lg'
    '=DxcZ#rNI5fBgGSLRZdy@~Omll6N&Jq2QW5u+z_S0eE+(xl^^U+Hw;N*$oXZb7_YW&LnfYkx!)tXj}kqtV)CDi(jxE@bPIs8=C&q'
    '20Jihy*)BMWS}VGE*u}Q=Du*`B(ai@$BLBQ&WAE2PQk3YgZc>0jN?N@0hXy2Glwqlh5!LkTD8ES_FcTha0F3Zm<co9nn`LylD4>r'
    'M>0J^N>)oQ>@v5=fQ|?jw1S2xnLe<J9H|NGpuRE`)n+K>{2fwaP%WbB5mEJm8M`~I%fpNul2Hrxc%=;K1pkxRrgpjg2$fnEHlItq'
    'XnTyDy^Kk}x{_2dq<2Km<BVg)<526t&HVE$ORgieKKu9eWVnIA{}=E}SPsyz31<BjyC;!8DK4Jqcni!V^1Vz&whSXAH<V%P3@6o='
    'dvu4&zDi-PeXd{leSEf7fU~V?t<$OXIOQrh_vt$Qw&zBeL(<yowAyA@RP9@pb!39FovsQ7xtqd~dDia|r@m0PAI*khD<^Xl8UulZ'
    'FWl~v9Ya|w^v<51T_xx5e|~#%`R4c))TeLfN+mU%d1aw(=8F$Az_1I?z|{U-Zx!Am{`U7yNJb_S9XH#V?5Mvhqd**QZ$QB8!5egj'
    '+=lO3tc*<`W?<*~oy|!ehgekf;lqqkP5Kxvf<R{mQ0g##T#vw%JOTyr@EEX4G~Yp>8dR#lA2w_n$P0LIq|RTlR1n98sG&wsgrBe}'
    'gWF-*wwPCx#nFc&@$d?_@^eK;{M%uXk^=J7hFUt^hDWnk*Vc$o?y%PLU2PEHT`1cHi;7&Pe;Ax_T8{sMR|%>pil+?JF?@US+p&wN'
    'iGPnW6WfC05-KZx`{u%CoId!4MInU6`JqK4D30sPZJT%oX6xJvq41rLT>!3+U5uK5L;4-j*UIxQ2L8<KV%J<LU~WtJ)qg+3y6<{3'
    '?2=aBu`kSZ=LaIiQS$!O(2-wGF5dZr5{gyl^@9SjAA?Iyd`(uK5yxy*yl4np$Qk25*~6j5kr`y(#q9Z{_Q!6;cLRkt6-fp5aL$eq'
    'aA?`l%U?N+*9#*<A3VrGzr+sjW^ig)gbtn8DBtLfS!WvfDM(0h81(w{PZ+l@)!zUUrcfhggsG{h{+w8kg^^S4B8xIV5mqO$GLdvJ'
    'RjW)yzT#2suw&*`zCZ3l*J;{&zE9m@n2x?5)*;U{as8@DG>Qkpv?Wr!Nn(9AYC6HkN42X+QF2w2{0IkhewSPd+(=U#k|stCWDFCm'
    'z?g<nr(3P}7LY2I)K17txBX$w4G?#nTm^FVBE7#QcCY2vu@{iAN6rtRTzPMJFUbTEx?Q6z0O4z?`7TgoSTX~{m5)YBB^aWNUAA0s'
    '<U((uDb`-V3$TF73^a|l5utBwivDDRj#Z{t1NbXU5CsTo0<IE0GkA>tP0|!3b@&Z$NNCNUJAAt-BUJMsLQ|q?%OUPMaVzxhx<FAB'
    'pH=@BQ|Tm|1&Z;8td;CRv++EZW6J25JgpHl^dX--FWpm85J`-u_z&1otpeHxd16E+h<b2BQnIc+Hz;Q*Q!>J^K{m@3y#rW-wuUV7'
    'E{j%ze>$?oMTn^SsX`;=Lg03YM57Lg%`dy=SsmZn%Zq65ZUsJf6{?cR6P}E@Y9iTr6?lR4JQ=nMWh5-|@M_JD9sPU;k&%#M6grQ2'
    'Ozpzp_lPxCLjm-Vve!XeVEB~I&s+=kCoJj|3QkTzL1_;K4_Xuo^4jxT+-4r~A<(ldglDHCZAp`iZhdw(0&rGcU?w%Dc*^{Y<e;zt'
    'E7foW&wow`c+Fbvd61fH8M@H96NTfHu`{REq5&*=p|I6hNN(N!F`Iv`*dOrEA7<WlGvBJg!gIrW-S$YP5S~Z6B`g)wA7pcgoGPVU'
    '8$+pR&GjW6jPlYfrP*FY7b_uH*W!8R;oLSm=Zy=rGLDKzf}=noBY*n}nQ=xJ^J8#v3>huVt-m<N<f#%&J94#6scck)nds4LiTNf-'
    'Dg<jWKvkCuObk-}<*T=ED*#8J7)p>!;&?w&)AUxmm0GjWh;U}SKzjz&DEH0-S|c_75I1-~k%GrOE~M?n(Hw54_c1=LA0PkY<nju7'
    '2GtZsHsHUO)C;^9-xe>muPiyMA#}?CEf4E{+{28Ki~Ik6T~ub`4iV)|UyLlnh;U*kw3zhIh<8vDL-{Miy)cWRdXxmiuq!!j3w>M_'
    '9hG6vAwvD?_>vIE`Ni4K$MM&UA|_(VPf3Z9m4J#Qly4EVe2jkb1?hRS3OZlcQ{*U8WKsCH2>1KJU0KTIdg3rd@SROS=Wh;>J!c~c'
    '^mUa$3`CL{pc8VvZVut)FLG5L)d6yES)AmMk*)gJwM9u#1C_ASy3$)rqFZo9m3g^h3B}AGaDKO_9U;c*9d)Ryy;A91>QKXW-~deJ'
    '<#N&-x3n?0Qjv1ELA;05JdDkxjT|tkgpg0z?A8vi3KEf<xjhYcVCzGaUn-#A@lL{5#oCoel3!-GVZFm~H`R-3QPvKb7KuxIS@8*b'
    '%zc@x5;%o0YE;EYThN45Gv$q_=sX5$A<_=Rq6{XONnzZZOl?jhba}~igxPoVWfyv%k#$#2r4E$-cJS=k-a!=dspv7yxtiWS<<zU$'
    '{y(Wim=Y<1_^j#yM<)k6-9mVwVMRQZ!qEVTkZKh)Fj?@n%92PjLDLi^m_koUP%J8i(5Zl1ITaj4jGzkEOQ~4i4C?Qq(uGcKib=HH'
    'dZ4&if5a6$r#2}h2zIfV?~YPT)nIjXdMCBDF|d!GSk0K?>J1ywyX{Y|@8)+YkHIVgCjY-54N)10n@9LxHjPe!bxApOR(`!!Gif8z'
    'Xj*h1<!<4zOos8A{o?SA;ufM6e!zTK`x%F<{tP3G#<Sp-wTfs%WN+{>E<>KYYaDS?cvR+d&Ov1UvOsJ8c3xIqF?0x?BnxDDpP&c<'
    'wvPJ6%_TmHlE_!<35L!mNn{V63TV&fjBFB2WJPE$qe$U=3M$dUXtkOGVqebtqX_>sTt7tkqL!3val7CyRx>UYuZnrVB%llK3LvYT'
    'QV-AzrNRb%Kjx1#7ZUr0fl^8}-wO=rPR5fF^nz-?wD;LaMs%xGZa`$@m-XOi=EkNPYLrwPJI0)bv?g7@6UKv-G*a_uu^9E1Eh(IY'
    '$?r#0`jH~mdVba#)A12kRh-^qrsTzFsOMHmsniGI$0}y}gf(z_53FE1onjtC^ORTO?2tI&EYf0bB`{ob{yi|5S@wnr;oIX24Cy-u'
    'V;dQdvS%Ey8oWwbevWK`NUT7JheMRR2MHoG=M$Mny;*9wQB>_>=V?&Ef_>>-YJeH*v_i+zIo6xRQym)d39*pgH$%^0`)eGm8qVfs'
    '%9ukDeT1N_51faYL5tJ%Q#sd(Ee~T$8gfaP6^0`MR_2;IYBaMKkxi37N#!7Mst&lRp6aRx27?+;9{7CBg)3$mO4tA@a49c9;L3Fr'
    'u{b&wImL5GkONO%Ul@@uxr`4Q?#(IIxe|6A&KKtdp}J;omh*ceAIJYVH{5ArgcQg;_Rr+i*~>T_&Ijp^Hdxu>UxVqSemne;r(NsS'
    'xLcKLGp%J78QK^t_{N}#9wA0F-b1-BGm;^=3<Q|WZ}!PgOUhTtx(&dM8&8(H1gSa>;W$4V6v^g_mV-jPsX%wkJRoZ+>}Yy3Swy;E'
    'Weuvsri<QS6jY2P2CBg6ebv@tB48ld603Jo-CVeN7i456^gsaP8bFBxtSv<4UWw{aDml)Atuy??42`%x7^&QNMC>&m1qwXcyB#qf'
    '*QkGw{8w{a^Pb_Fu}Y5RmR}!x%yMWMTTGLl=WET!lwCRs^Os`E+vDZPLun!I+@g!ptuBY7)A}nekh2hAh8KwE#}!Fg9j{y<c3qVq'
    'vbE9)JnS?$A{`Wy^QGdI^~H84=P$#sCDIFU1*k1|bXYt5m@}-&E%y#2&+MRX*<WEax$RxMhxp4pwYNri8pwW%kYL|%-ihAwI*p40'
    'HA@pR4JSqvz+irLsj<Fg6vApSm!%zstl@4{%tdLs_HswnYF3-hc`FfKRbo8T#NIgFWGA$bYoD-WTHRh)F}0X)#ccwaEhtz8n-^ua'
    '(mbdAi!$43W69|B087-_9AGZlbyy`GPuL?Bpn22+ktbGZw#?0~z*a|t&qH+U0vr}ol|_)HV)Ic%@|phZ^6C{7{IT-megjl%K)PW7'
    'fo>d(B|f_^#mAK09LwlOp++i->;OXZ>PDC?6y}aDb>jNB46Wrz9zh*YB+ZjSvJ5ei6rT~hbF!qfP?9`}MQZGokMYWdWh5OgQ>Mry'
    'D)dz^%rOa9Or~ZDRsqyjNQ!fF;rX(GM1GRhgE(zWqfB%uK_g=YizAck0WsQ<@KOnr(NgxCXRCV180I(e@w}V<c>W~8y5`OCrk5s;'
    '(84c!tsgpn5@UgjQv<YeCSGXZjVfNQZe;l=%+Y+7mGj^Gr+}i;mea3hM^lN@M4obd(rf_gnS^a8737JiW5+K6_>$lq<-uXy_HoVZ'
    '`7FIdzJs|GmsnHkTuCz6<%sPARPGAucLz74>4Nxd&@TJcP4sjSo7(K<3~($AiLIzw&e#w+<?}Ifo91~My7!FHog)(c#TnM=rE<i('
    '<&biDrKW6sd6eI(u-}u}C*cQlT@DL4@wQZ}Z5t#u;><qEXv(~%h^R~Xzha``8=LK(EjuAi4o&~)I;MUT7iAw&&l6{b;1D%KS4hc_'
    'uvp;>7*Y6nIY-YOsSRNHYVY*NtlI@2c)lN`+aO$I8K82{D-dTHHV8W_g!Ubxt?nv!nZl}*b6MS6iW!Q|h91=gY2;{i3C`us05%N&'
    '@KoapCkIxz)T!$Ma{#+o$Sbzl9{e!C%5ocSJH$+zWmNHI@<f<Vr-ly5{hB#G@Oz)w>r5QDyVTNvK-azZ0bE~iNB14R*B3mnmvrmX'
    'Y|HPg(%bG4o&!c<2y|0Vi6tgr<>i|w&$if7*HqMzc6-#Cv%umlSMWow1HlUNVmJcRvc{Qo-^GJqdavl2cjavW1=ZEa+<rxivqMg3'
    'G}Ku0tJypOElDCx#O=x<2X4p~o`fnq-`kzWhDaf00gK*pHNkQhoPkQuU1E7i%XKB11(#^r5KmO&i`H*;9}El$oDc7#AWIscAf7PA'
    'jCDTD&Y?*3+q0LHNZtInJUhLN$IJO2qZyRH_zIbPZ|?fF)%@dVR$~WAgV2=d33VGVcVSJq{D|Gh;X%!CNVW0EaO(iX)+D(wP;Q0Z'
    'M4VJBOwEx@f;d8dEl{;R7T$z)Sghi;g^hPu&B3)9jZh6ocY6HW@dYUPpgi_$u0?Io+w@joYd4@(=gO5_e1dot7#-bAIh{RbRjPqe'
    '>kjz}c5w#Y26cIp)N0OzIb>GEY`$I84{;NIXFUN}ScO;cA=Ulmr4|}elu;n(SV^(v{B@zVaE;u;PA^~#D+CbNJ}%FU1<S2@$1EGi'
    '-aX_P2)#Hr8z-r&lvi-{0tc}L2n9a&5SjaoLaqu#2S&Gs2M<*^d67rxucLeG3#xZI>vMIN#^EnVCvT11_4DyBXBWqyBmM2<m7(yj'
    'PA<=nu3o+=T_mo-T4Q4e?HRv<%pR1l7z`-@;u9nICyqrRvP`CyOxLz%c9Px=Kt})tr$)=A?U7+8r}(ijRdu3-tDZs=z8&564Rxci'
    'DVX`fKwY)<!D+YRuTaILrqn?Sq2R5H!fkX#UMtlF)5>fMflo$>hSOg_MXb_x`5=mKP7gsVq1uVKK){OZ10@9uXhT5JnyKL@D8+1q'
    '8W-^-V9h!fj+svST4UB*8tiSzjcH)eEH$w;WoR$GCs;chXDr3sIqME64PZ*P977R)!1mUEwj#CQU1^VHP;q%it!~+mxvGS;w|JzW'
    'D#SM72lGFLUrGtr3b@UM^?InQ<<VXea1sCD(qd-{q@x3tUDbvxW_1^5X2gt}`;^K)=;1OvF2ozh+^dSmvFsMSx3R3aIQ$~sm@wZ^'
    '%Nkn24e^}!e>a3J&8NsuZ|0u?w~U{LEm5pW;d>#y<b|gTX0QXN+*z`UCN~fjH6EkrPpOvZo*F*XchG`Y8TTGUNS~8gPo(~=3u4<U'
    '&2wpW4RGTGZ1QiZ_a$B(oZkwwAmOGjuuy!AdAQ)7LE#v56u~rTaf9VMs*V6nt3Sn(FO0o*U=6yOPqmF{rQ%Mv%@L#UH#xz&l)cop'
    'C~q$V!UIz#2f?Nk&4xeaKU+9}zh-!(7tJ24bboPV+a<W?`Kgq3VrGUEFDEnKm<HCKLom)9oAtWk5L@ML#fiY|1;Fm`ih_D&Q~0)M'
    '!X*VgCfkE6W?3J`yPSdq?icJtC^PXOK2$rirCa+$)1|D9jm8alP%0A)u}CGXgrQU=f-X)DEkVA10_sT4G@BVM%A`YM6czcY#bSH-'
    'k(UQ;+azdJdw_t>jZ{*>oTE;TWW)%!%)G&pY<&N!E&0pa2^<~cA>rix$mS?B=W5m6_Ux^V@xSdyLT}rkBxg8etYoXuILIB22#urH'
    'oR0><HGgtVr4i7`UG-gY@@J9Sn?&Y6yR+JenV*Zy-^S&+vJCUNd9=J9;dvEK$X@a_NgVa807x=rNd8RLqHPMJ@QNQ)8wH5s=IjvK'
    '-?}JfpB^jZ=unsv@^J$gptBCRUSwpnZILGFP4quq>q|utVf|3G%WdC)-E@=zX?0UNega+bXY7`G{_48`El11v!(Y671K?rSr+mAZ'
    'aUi`<+iA4W(kxB~h$~O1UzS;*+7?%{IQ$Z}!4_RfB~7s(LV<~R7l19ia`B~J&@}nH7c}jd@8C@P>~Jk#LFK215ghD;ViS%=;&>7b'
    'fCUHFOHLcxBBAU_^t++i;5lf^nHFBXVpQOi5<XqE*}5Da%Bd0vT-!1{{}<I5FgAlhO_m%=%YszoDL5&b<;9(b<Rk{Q93)I=Nz{`p'
    'A7+QS7GCkrRKi@f7~5Fs6m_-`yQvSUI3ux=pUtnz?Z^PaFuGe#qyBt&kDDK1AX3O4mz)bs)?wFZmiRPowk0U&uZ{g-?XPM0*NSR@'
    'JxO>I4Q1Fi^eAsxgsor~rl36Q{}vzYLh=)#7_zp1zdSn?H`<K&g5-k_Xon+~4CUs=;_pCyBQzi00R%R?4LA`SRLIKEWks~234dgN'
    'BZ?#4NraTT<rvP)M=_5`sl{{$F^+HeSaVWFJW>mWqq3gr%>R|F6q;_cOjh*poMF9*x%hDo2jFTf28fi-L~$gZ^8w}hvKQVj<ig3i'
    'vQY*ZFtmONP#UHQ&L-=7t;$K*pyK6vXkb@;-Y5B8ZCfaJxu)<9Ul}T4yW-oNtqcVeliVO;yjvwc7j(O<o3$4+D!70dd(ezeQVZ&+'
    '5GP+s>rNk>n>oUY$@6z+SmNc~f{N2{fyUWTdRvZodz1sPO%vcOjIzmX&v~8f+@nFAlNVWppf`COepUCsWst%*%nw@g9jU*D=tUj2'
    'LRm4WcR=9)YYbby@i>tQ8KIH?`o@`z%Bl&Kz)2e@$z(=B_H;ez#Igo3`&9XsnAc(#^B#L25EH4}%9F_9cg)Ua4$Ba-S>6^-;sq7N'
    '$v7T!0n^YCHg6R<KV<gZ3?upyMdAEBDB9JvpgebSz7O1DNe>DF4g+p9?e#~~NYGk_px8@AF~i8X#aTwqy8joE4I6{RtxLm<9+S4<'
    'nx2NfH$~nfQ6QxlbR?`n>!NuPZmM?UV!MNWtgS_-gm$)#*vjtK*2vZm-6DL3qDUcWl8q|Gx(<r}g+X0%-pnp9y?8E~jmIcbhaCy*'
    '>YB0SG+bv!5Sz_En{KX0kkT-qi1{?s`DgPXD3}{y&Bl4CvziY=L7R>XM48Q#zB#p_7kI)!&PO&8%+bqV9d<WJA`N<EeXVoG3@{Qd'
    'sr3BJmZ3*uBlm^w*;tQW=mz<?!?K2V5P@(H?T2>*bG^`ITTBR+zd`i|(Gw<2@z;;7PgG?&`a~*9;@nuDk8$!p#H4}zroU94OZg1v'
    'lu`kET9@iFo9DgoGg9J9_FR`Tm$NMRS+T1wp+lw{or2ePqO$Q;TXtc7%1{e;URAa-g!;Y6A&Y={GS$by7Tnufe4(<_{NI2wu+_s+'
    'f|bLTquU<X%FIz395LH~D#hVLR&FsrlUJ5-g~0lx)dE0!6FK!le*YV(hg=$o2+=+?|9YCBAkQNU1+EA=7$63PJqRqKGx*GND)4jE'
    '7msX-hnF47b;`z1vE?`oN6XsrP`^R?b4fyJ`6o8y(OW6jfj)B1%9l~Sud_#h;27t)AJ5G1v%^@B2L9vfIz^chHL<5bDl`X(azT>P'
    '!USL{HlQ|xj-%4NqRuc-JW#czWe41OOofbWGu1b_y9N3OG2S+LG<Qka&RP0JbdDCD4kdQPf3axE^Daw+%<$>iu1&*?eR|?KJ+bs>'
    ';|4J;(%oyiqx)3o#*?Q?Q)tWdFpajPe_=uw<GT)h*P{PCg@)bs=iV&42{vuDH&IUMPXAH6B4c<PV;@#+(%Oxi<8tJe51ZR9H&8??'
    '$!r(NNclmx87yO+Wm&<FXcacq$Oq%6A?C~Hr1=%ywVfpqrsBCdPGu`VDIA=W^?Nj}Y&=fqUC<N1`4bl!5|dg==@DY<?NSzJwn3^}'
    'kH^Fw?=ZIZID%l^<QmZk_!xb1s&MoMNzmSxBvs|wL7DL|>+>exBX%Vqb)z4^w&BZ`vgUl4kt8s~J>WDGIB^McP2Br1`udHmLF3px'
    'E&4`f<^_VhAueja@eN%?FsN?P1I&w?M?P`v0pLmS+jz_<HyPKN*9*=WiyZ1|!t@^*WTQ6>yS>=HAj#b5Q_b{}f)wz^0J4E2Na4#y'
    'Cr;xVqq|(_rUorNN{mUFv;I4FUe;l{@FdV(PpXL#*JOJ8v%Wogkwp$Z8vqYHf82WWtcM4e))2VpeV)-Z5=K>G3L|n+Kob=)Bc#6P'
    'zu}5HxBeDeLdA&YcH$iEsM2{^&?1jj7PqK8HrZj**9iO=;4mPg&zGyzWu5^iT~r5C_%@jJK&l5Zn>bdpMU&~U4SvA{!aa<wMrsG$'
    '*C`j7qyyXi`Q)|ILD(oxN<A&^tr{H`ImW^<)fO;g&moqEQo|~jO-bt4TVCG*>8e4{b8R)B*QRsu93l@=Qe(3JraClqoKU~3>J$O-'
    'sxx&%67(jnEF5$K$!fL>3RXQ4WMhs4{Y3^*dkK;w^rB9(MRe(DSt(ui`v7yHj&j2bm%y2jlK~0{I_!TnzXeQ&Rs(Dt^lX++vizWH'
    'P8$_HM%G}BP&yh}?|oL$NOW4(y@Xt?AL?DQb)G?+g4QM*R5(|sj@iaf0`nzpbdsPF3b<RUh5`bYa)Br*im^H6-NVZ|J;WD-ksoBC'
    'PUwKq(}UuuAcmMcl@;Jn)*JYsMjvdt<GL;0ZsNW2c~Byo`q{m*S)X%x<|x~*YKjlSs<W~7R<Y6~M2a1&+Ld2V=Y6ynQ8rMQ1(pE#'
    '3bR}oh7HPL%$H#re08ZfBgRGF+7uZ><~>Sa6JR22NNCd^0iKnVBtv&I;Eal66|6r@xo>{8F#L91Oar)P(|wP@<J_f)jl>!MTQ+g9'
    '_0?C|iopxo9mN(Ii3>WZmJY;00bZ)&%uCK$ToRMO39;#Lha(74S|)VJ*5d@_1qbEa>OR7}D(0}%`M;ufK~F<LK8Gx%7_s@DiRRuJ'
    'xowI{bASXFG)S3%fU=$v>O{R$Hs4Z2G}yHN?Hy!em#I-mjRZzv5YKG%8RMHAV4*VHNK6u{jNV?Tgtn=HUA9G?cd;6ADrKAJ(q&St'
    'O1eMFMMhq%w6Qi-t%Tu0TCU;-HscoPs4zgPq#?hR#$a;8lPLW_wNM$J*~dq00^;TqVD#pF#q<5aeS;^sRc59UPa;x%SK-@ACh;zn'
    'PZQwLBD+9HoW(O*pE?;kNa83vuM@1aU7l2`g$$UQBcWpHGRj8fy3z<Gm@;GahUyOR@^)^v62jHdkBIIJP6=VHkzF`7=)lWvobBN0'
    'Zkxk)K&n+upN10810JfmVf1S=<kP0DAxd=_%96q5^aOl0o;;Cls%n#4#oF5<aW|-DEN?lQm<P!sGn_pYyL|a0T4SLrBWYfyxXhX5'
    'lG73zaCvJbz76ydC~_Ai510A+2%JC;t_b^PLw`C+b@68fi?%?UgF#!xFSC%ztb!|Xsa>ly9l5Q4c1oqUqHIQwaTOmt4b02^*dUmj'
    'UuLCS0iqQ*?q-z|aT$p3lZe7;6AY(yPMp97-}cgv6)Y7{ZQC$#Ew!~X$_dqX2vW7UW@m)|d^%Lob9^eTHl?%+B)9<&i$R~A5akvx'
    '6x)V`;Vhheo9E-{g*Z`OENNGfflV+>GXZiEMnO25L8PD7M$t!TQkIvd-Efj}L-RwT#IQrdOWh41vX3Knp=TbNv>~9Fk`iR1P=jnz'
    '-D;uM3kY|%Dpq?NwOha$zuuqzeD?nI6$vD)c5~}{oUpKmsK!|FhkCKwNs80Q`D_g3bi2SI6)1Wc*iCaRy=jUsY!=ftmJP#=Bo{4n'
    'r4lYBM%zi00G@!+abje?vFVVK8RO%hbeTV31Nj~Y11OE>x$mM3CVE%=0c_gx`co_g2om^J!8u0QdxXuZZL!KGX?*eiG<jvV>8-(8'
    'm~{zS2+Km=3?xaii8rlKADw2mO)o~XPo%T|B*X?IQoyhW6sSsrMy18<o`#L^$?m>oHPJ;8(7q1)Cx{V%((cc=u%~WC+wEV#St`x-'
    '4>71cfIPLq7<?8bqd&0kpP?EO6iEZ#0i0F9Qw;LKStSv4KLxy603P{P2qu)OA@?qidnf^GK|{Zu9fCX}C)<`%1tHw$FD2+C5j%js'
    'OPLVb=68WZJ2^0$SE}$IV0)(|hmEEa65GNia{$wKR6L-<(5A*zI%!fun0+km25%=Un(Tx5t%@XCyjbJrzb(_eMP<su9Zoe8LTx7*'
    'o1zu$Pd`S1OiV8O6#PY+oG&B1O0<xdZ_nPp`uX_u<(uU1M;GsGfkUWH5$B#n+2+5Uy?y^qw^k2y<BQ|hCugTX8x6sE@`Ua)qG8a&'
    ';>||HNLM~L%&X(`%jD?&)tTYiE{-qX#O5aJMwh>yoF|Z6;cbEm1LCmhz5n^_>?*msI6A$A<f*ZE1>~AgU=Vyws(!&Q@jA5Q3`g>u'
    '+NsXZE>2#boF2V37%4e9{pI2)IX=30`%g?^6h=f(!AgREMBygV>v{UQVLMw7+2x@`-XGnQrUf_y3m`VAy=Zmz6DVPb$|8piKlhfm'
    'I~@BqUucJ82%k1z0vli_ZGLxSDMiM!!9Yec3LbU>YRUwwq<}5HT7x%smOMT9h(q38-{9XiN^fdty0FkDITUfQUXV_1@204t2H2As'
    'exOQS6w<uvT|=gYZy6t$Plch(d2VJIe)v!~42Vua&^fC8N3ZsWVRMptt@|{L3WHLsoL!!BaM)B6!E3`K-i}s1FgV*J^EgWtR<GP~'
    '7>j#eIcpqmXjN_mW^z0a92%}uIBhH&)T5#;DioI#@`>6roF0X+AWu7)B>+50I_oXcoB2vXT|@&SKf-TOz$LVEa{8MAjkAk?8cg#R'
    'vp1@C@eFE{Rwk~@Hcktp$8&R!W3T&agt7&18NbmLn<7NO5FRlwAUh=oELcR~TF(p>@hg+9xwyEV%hRLt%QprixrP05^7a_KO)+Q@'
    '6nr~irrQahdh=~Ru-D5sN95)yy?Ab(Hhn(sbU9;{js`}EOY10&B{!olmF8~M7F<(!)G>1UWRY$2#&Y|^{y2UD7cFX%AuPvDceYDI'
    '()GuUy<ZWr<BG41iM#dq-WdLg)FRc=G=89v=_o6xF)C(u#&X4~A{fPA6XV^bEo2LT)N|nfq6o`FiZ5n)dJ1PEaFzjIPldTrrBoAo'
    '5PxrM^8>R~WNpKKVD7{0!~QoqWs+N4k=@tXDKfzKeFoujGw^@2ftT~i#hS}(Pv_Thac*Vn<lBMN8aK-4LVFQ$4(WnqLq++g4NK@l'
    'E#Mx@cDWkdhI3@ziV{C54$Oe6)(Ckws3<9qZfq;$WT>{L(K}D$)`t&Bsr9ESs}5}WkSs5TJioc?L(+J}CcP<#WB^WneRB2Y{m;qO'
    '*{{c^<~HljXwe?pMsL;Av*h@fUyfg5*8k&^^DDptA{X!h6=Vl<mJDFpxSm+H?+ajiU!7dUPXCc@a(?vBw`WJMkN|P&2(GVG){=-y'
    'tgzCiSsed@S1bFRiyg@PBnx@|^Q)ti)8x(B<yDsR*WHx9|ILublm9r5Lqi#`fT4kq+Vd}k4c{HVGjuZ!(SJ7I;_qh{zh0h0bqAJ&'
    'pyTBA&vA%ePAdIvrASb~KCVvQ9iP3wN-hoBY#52}CrWJg8NhNlH|PZX^^NfFR1sCBJ4ELtX-m?%0Te7s0eS|feJ~vHU8<N$$>WNi'
    'ij>bQE=@YWCIMJG9T*8Z{u&C(3R{RKsfC%USSG?2#lt0%T16!;55G~)0iZa*C`$ht`9*%W7%^ZT!sw_=L)9?;1TGIX3UtxJZsn^>'
    'U`o?N*#Bmv>%~OA`DJSOgUZqQc|>;|bBY^+-9ZA;ZO^Aeq^nRvBmSDUxDvZLQ~IltR)H8ooNUFf(yofOpBRben*{t~0Dk4k-3;WD'
    'Y70i|G`gsG41Q!~k?Ha?@CYk*wUWv*XzpbR1%?dt^ki-_G0uxXO9G!U$al|K^S|^%@dAMX;>U7sE2)b_X@e<`5BZi<#pQi=2RhS;'
    '7m;0)l~4V(`5$?d4yr%^MQEc%)ChF#lC;}mUyK`Vz7_PHXmQvMh|i`*Qm1;>^c#eYga&A|#Rkd3qe0A&dD)Pm!AP~{Fz!a%!GB_X'
    'elrOwRmPegCht>BP?ifQRWo@>AnT9>5})Yy@}?SP*dO4A@ds;b`6p{@JvLboRGd?tdUd&SGEE)!!EB5XZhU^c&|}Uiz&y@~a|L9g'
    '<|&IPuiNZ&rK&guiC*9w^~9KA)6cyLx^3scG$8FvT#|+r?K;?ls}d2}O;@Q{x2EMBLV)QwvrLZ1Gs_&jVq)-Fl(iY~Y31VIbH^qz'
    '41uai;FrG$Tt4RbL8+)^>u)E{CV(j`Y%`l>h2~I_|Jt?}?f1IG)@z_g(h3)4nhvXNz$7JUtqU)4QCsc9PjiLEvl0uY)qzCjE7T|?'
    'w!{wv_RCW}yOUP}9z{8=>NbPJwjl;(GtHudhhIs3#TGq7xqbvK92R$~p(4(!=Yx?{;7^R+#sG2XWz6EFL^p7}BM?PKxqLan;$D*4'
    'w0}4KX!Gm<<H9;UUymRci!&`5>1=V&kD!C3C{{uRNNhQ@Tr8`ZvwizJ7#AoyTvN<k8HMmb>OB;x?%?*oGN1?!eh4O7H)6Hg32pkJ'
    'ZYI@|0u1tkQ<{eymgkg9%*I4ZaBI6Au{#qoaI}(A9ZqIxf^l6gLbktevH=Bba^F%#L?Sq<hkn>Bf!hcw9es;>K9%sA5}2b63m8w-'
    'fdFr7uzcSz1uF*vo047qi4(BldA2-;!nBf$B<pSUQ|vez-gO>wLjdO3;|0E#;&Wsc*3FYWvZ*Kn@@<PZ)j%%b^9TX83s^FXKXpxt'
    '8un28YvX`D1pmq`A{T$C3d{I3ZVJXQJQ3}?VP%ye`KLTxwY3?G%7L#beoH>6phdD{7HAOHIB4^QT3fEv{Ey;svz17*e22GbIu}pj'
    '-l^;oZVbpNL9szp+?8F_3N|=U1(Cdyw62i;`DS68I#L{a&eiZ4HnF84wyh??7p=1HqOF^|oSm!M>G^N|5Em6f5k+FrEv|V({1g|~'
    'qg;3YNk$RwON%YJJ=<%zYsziP3zHRaOB<n*JI#t;#h_`k8x^t3bn0H*bADeVo;|goA5kImRJ51^+yek@IcZFrrM0iN`e04WMGB^@'
    'SF(jS>w%1Uq0nC$yUa4ofvS2`RyAg0?LO<h&rXv#Qn?1cY(X}X1Csw|E1F&$|Iha)7X~(qj$+$w_ai=v4$u{<p|!^L0bMm$d8S%a'
    'XFv;dnKCdEIJVXy#G9XNP+U;mReJX=2cinySbkuwCn#NkOiE9$GQ)QtPSKXHU8dXwRL0rb2oc6l`6<716i%0VD@3*1V$haDTqWTj'
    '|Me_SwJf@18%DyzoTZNFtu;s!o#IwYC^Q5}KA6tu3(3sab7hSs_QVDs;K=CA<rNj=Iy8APKH47XWa?~1In-BBf6M9<%p|q~mBJv2'
    'auE43xS%W_;yZ|`slaZ44jWiz36z^=&$zU;FRtU10th;Vdg>^u1e4)(RR6!0bRyZr1Kv)Bx&`O8<@xZIXOyqEqH)p+kFvsp`FpE+'
    '(d8H^q%>ExE?yTyllOct2v5v!Q|?JrR8GtV1<T`V72F=Pcfgh(70mvqg@kdN9<Pk>pQs+(RYeG#&4Mfa3W#9EUsl}bg6P+l{Z&1z'
    '4Wkbvj4pmaDaQiwy9n;{ifOq43ca#QS}tlOb2~~4vr*lwhT;}!f;l!akFqVx!c87fJKN!K%Z>tyBduTjz)JJnK{=A+Znr~n$Wc&f'
    '`2qm}aw15|TR`#RJLuq)@*<FI+NMZM>P=z$@f`fEDNd8cKGbT-AQ%LW3d0R(EdSa~#E*KEt~c7RHX?Fu(DK;-Eo7F*5e;6Q{rwaj'
    '3oQ3}d3^L%*hkHI($@RT^?w2L{{8&AH?w~c^ZwxNTerLdmK-sY&NPKlZa!L(`?QQ7QZCtt*JypkWSLB+sNCh%(Z$vKbLE*~LzW#X'
    '<`I5y)og*DYW|NuO3Xf-{BlAcuVV_b-;2U!>wXG&PwdmLm3R66{P^OxlgqOUw=An#z^GOY5uAU08-8WOtx>$EY@ut+_ev^?ChExP'
    'xX3t>uyHeHniQ>(tG?T2DN&s9a-*zV-DE?h9km$}i_D*rOF<**OdzGZ6FJ7!Zy9-)`TY3w)ye7W<oF*~#}}vO{+e5DU<0+p5pQVb'
    '2xfCt!!VPb*H@kb+1pqveVx4Ju>@qtE?IPzXU{i&z`8d;={A6##sB%$nr%eW5|_!&<~ZgINX!RH^+>Ld4L&_H7cce4DEK&;f?Ndo'
    '?J0*YB|=`-xx)*#WExfhowkHow3x9?;h~Ty*<LK06**;(2cjHQ0^YDS!oX7H0GDFDzWc1qFUJ`Gehhv!ZMm8&SJ%zWD(K;CDM1vt'
    'FHD1zowFSdgOuE+;L1Q<zM3P@@eNxMcO`i%s7kSsoqv00)-z9Kk9N5BF`gZ;Yn<M;E|L7}>ET*XD&`RjTxG;MVSwt>Z34&15RoN}'
    'h2BnJ@h);q0S8v+lv2Qo{=e>LqU0UlPo$MI3Yx1iq*8$o_d$`eIn+U3iC*G&V!wDKzmu#ZgmylejXtmQKcNZ@*yc}plc19e^;51@'
    'vhcjgtSq+BV51H*f1dx{_GU@kxzWz7Ac($rpgotrQWo9ydv2%&kOGJRv+3@88G<A<V#2k$5$_;TaJbt{@;*g!Q~$HNjbhI_&Ky!G'
    '6R3mc-S?StfS8<{*IF?dJXj?0y|c4zEp@Q8p*WyYS)&9&Z8$bXfSZ`{!b|jq4!qILmhP^mrA}6)Jrswnyuad)!3l1ZnGa^_o6Q{w'
    '-T_*MYl#fujjU(!^>R)s|GOCm%Nf`@KY110jF6a9z7CR;ugy_|7pk8jp0lBW6EiAHKHrRHtV{t6#@#t}I9$ZkZy-~tP=Yi_o`z}|'
    'GpRr3xBZEs*j{QhJ{NLj1uxbgbRzRDGNX}+me$rAQWR^_pCFftVLN`BH!5HONQ{$g&CO@TzoE4XriuYTEp%gZ@a8$YK_)1d?29!-'
    'W}FMu>;Shjg-!5whJ2MMCmK7*1-<1c=+9R-!L?jHcg#~xKV1*ZydkC?76+S-7M?zo2IS4RwjNke+x{e6f%;cy1#7N(iNy?idS|YK'
    'J&)2P05;rzl7hB`b&qS~|80yhFPk>CAn&e~MSS)|*^)xpId(CWhTvXk&?9ipbJ`t_h=4PSixH9X#O46~#AcpZ7o<;Zb*J*JT?qG$'
    'B1?{!s5)K(KT<*14!LXJKOuG{>nQUVtr9a}AL49;?{Gma-s_E%C7AWTQQ0OSFOOQfexp{YEo$78x87{n7cvc!AFwR<AS50H=P1j+'
    'C@zX-Q@}|@9f;PpFLop>EbpR=42fQw$Et*UFVv*D+#k;xuM+xc!o6|VDf<%Z$0G|)7352!clCZM^kerEv)biv7)nZd8MbU%)lWG?'
    '+X%>Pk{UV(xl!q}j{BsmCt+(y<_A?|M*3KwSF-#<jPG|Rr~+{mrPTz)ytY%3`c%&@Lc;H!@_+l?G7+Kh#XI!w;ePnwJyqAnViqz5'
    'os5N<U3taHe==;Z<N_r+<`nq}ro^{&j6!D8xC6rTf*@y^E~bW`32R~0gd9Ab)<GA;nHI>H7$gmz5uUf-lN#KiZs|YDg2x*KRa|)R'
    '$jq<@`pQ}pGxKS-0z`)bqU+~Yr6N!x4AF8a5i6@3NC9COsQ`;YvpcSM31jPO1n+=N-6p>(VoIDBrsPnLQQIe6)%iv-4MBP4)$A+D'
    'LDHk7Y!)qK5}gLt9xPj_G`5hT2vH&Y0i@R@P@@finq0ydfET$IL}w&CfJQ7btek=VPmT~Ht|0zxvU0o0&hz8JY&C`2$N=z&s$>FK'
    'X-j_4+~IxwW)4E)PFNq9n=#taD2zxm_m)d06j7#QP7#enKbe2zBxIA>c#h>P>QfNURKj}mtA3fBT)sNFs6Z=&K+%td&w`)a8CuBp'
    'pwS%|gscu#fAepcgAQl{rN9<864x16^N^3_RKjMM;7$drA=Tj%$WBaooBw{1tLmMv<qZ&w8(tsdd5?z?{d{}&^4H|}AOBnZI{jH|'
    '0in6!e@@O2cD<a>Z7L${AluM+V3&Z8Vt6rEBP9?~(VPk?j)xv!odD9TP)<J(hXp^apfb@kepYXkLg~ebfWWI`B<WNY14MaV95c=;'
    'MGTZ>;xGh-FY?-#26%~`XRel4k%B%HvJzHX0V)TgAeYA)M_T!qi3_5phFu45{$W&-4456ghy^y+5BYJ*Rd+w~<N^pFg|c~IcK$H4'
    'crSyJg7I>Go14s5=rEvF0PCJ3$<QF1Z@3;Di8q*GnYF&z$ZNFC&^5Hi8X3rxV0tiem0H2wPFo<Dtb)U5C|ekSz;tYxb(>9}ll*fx'
    'V@U)-0Cu46Cq)L?#tO4A0biWO8%q@l?`GC>q|H#81`YJ)%B+-4Cgq3?!kObjd9m$y0GmfT#`c{MYk5WdgW9;?F4}`1z?Z1kaQ7=-'
    'huo=PJY-d7#6l7YPm)l}pTaEg&!5FD@Enum(@(dahoKym8;<x23>HA07e^<^x@&)J>`FKSHLWTm6+NL)1MQ-{_ItSITe(GZDp1=M'
    'xIFM$a;^sQyfl_q^NiUv_vBn6`gZ5b;PcLz1~gKJp>~a|L8O3JUO&EyF)m`NGrTK+c_$+qbqkCKd0C=(8nltQ<g=cm2it+E>>;3~'
    'xC1l?L;e3ugunXr=KZ;i_h-~Ml$iDL68wK#^cVvF?O)E}wth+IjlUr|&n5@x1(KQwF?A*#Ku&ci6Tsw#9P(Z$B{(l3715sc3=&1|'
    'dL!J?tF!Z~<5y^PgG?b88OQPM{J;y$XLhr+iCKanTu7!of$ATIvyv_FvK({Zk?nCSLvmSqV+D<>8&EeTYz!C;W3G(hgeiDm;zGCC'
    'k%6_)+Z@D2^6L2N=;fQN|9*B0iu`_<qdTM^Da=jknRfD5vn`qK<0+eZGZJ1<5RU)Qh(xcX+n)>^e7s;lSB9ZH+Rw@n4wfGl|F><Z'
    'UwLT2qs8;(Ea?SNeL~%0xs(_Hk>9>`5qiGBK#9XjuBZ(lA@_k<#d>gaan$7f>C3azUrsLGL1uWvYEVycczSk~oWKA1?a3uv6u)G{'
    'L$FOo8_n1zi(K&E$lZ)Mb4hGsjRZ_eqaj`<jc3YG5$>az$|4Sx-kzN*l!-2=4CjN?6Sr;J+`)8Gza3V?N5w*~v?JT)@zvGa96l=E'
    'q(V|JQD1Jg%F7*`xNfx_QzAGQ_d%`Zwk2GH@yHK$O_<QeDluGmwe&JdW`ysL#mRg5lp7g0*cP|o(tVlUzzAX=>zs_YM3PEvRatVo'
    'TvJsNt^aRGH&rP0xfJ8*5(TMTU8-@H9}X*`ITcApF;bY4YTLY4?g+kBohmpTO~;0$q${$*vluJ2(W1NAWCd^G(53*0S0ms&<Z&H-'
    'zBC|C$PYS%#~=hW6Lv$dzz~ca(O3w->wvD7s|%3m(u&rPl3>%Udi{}qTtdEINgtpu6^};lU-gPer&8d>_?7X0i-_#E$T{%2sZ#;E'
    '#6^WlM_|@Z6B{C=*QEwONl(#!pkv?2hnxPTiF}I~Gq%;I$Nza}?wa={wl4ZGDhTWFIxCt7cH#cXZHL0vZa+LfGp1q*Wv5RQP~0Ry'
    ';D?E!>Z9>^G*~61dQNi(Z!7LyNoBfMqWi2s(2gWpvUXxnGwQJDP3~&#q70T`Hwk;;lYNd^0E9;~jBJj5gZw&`kWw(#@CMaxCus^5'
    ';R!~fiVkn-4e_lRo?+az%7!h~D3@rB>$%J6RYLjG=9Li!fvflN_)b^7okjtRXBKXePI$`e&v;E)fqs8?e>YO6&RkfQo^xgRb)JaL'
    '2>Vigha$;w7Y-w&cYVMn6>o~p-Og}pa$K$4ossHp#7h{#KU)fpe;2I@jChrdGrf@&emi*uBGJhu=8>13i~J3s3^e&$M+wnweky&g'
    'k9&|Cpz`4dtX!H4u-f+>wU1EP&Dt=Th(;5!dX(VPB4kbo(V;J9-UXkxA4Uu8*99mUnr``Z0WE>uO3;LmWCea%{-YpCaLEXpyL<c3'
    '4i2BcX!QDnVc0h3jA5f>rYtu3k0)PN4toyG5mR&ci@jj6o^L*OG8<1C)&^np;V;ZT5Zf35=NXxXZ8SlE;%++W3y%SlZ)ey{Uvow|'
    'i-IS;7Uf-nAtA+fr`fGiZPf%^H!C(&ry9|$CacOJ)Sn}PBgAtHH4oobJn=!J`r$9g(!r{cux^zuTq-TAojEx_Rt17`mx$>*Y-pXn'
    'Mz#{z{E96n6!CQPii+j@b6j2?)yd|fDMdVi`dJ(iyz#W|*gmb6h1(F-WdDLDBQ6H3$jrt%#Uf|;OYh_8=={VYY!m_(69n++cC@;g'
    '53!tW)SnOUBd+b^@Owae6i`beX`i26UZH?ZMdQOA@vzwmpQ0^v2O00S7uXASx%6f_`cfya1sJOn4sH?4Gt17kph)jvk1HxlGyTik'
    'f7-GqC$F&PtIRxpX2XA2j74x*@X1QdF#a}wL@qXEp<MH;4{&Vuk0YZb$8^keG}Wxi3sc$h@l-^EyIJ9t1zcZK6%o_u{9m`yPPI#}'
    '1G>z*osA9)TEg`tISg;TV}T19-z_J^^VbqF`)$+p5dUQ=r-{$3o2=Q(!r9BU&=*~K-a4t~wm-SPo8P6Z2}@9*PsG&w-K2r;qq>VQ'
    'Vv>NzRg!3N2?Wv9#`1a>_DL^#^5mm#_cU&@1@4MgN;Wu2GGIWAz)KURd{!k2v9aEV56V_sbuiC~0^v#=?3;1)^(k`rFG1vAyfBv>'
    '$Yg115kP;}M>*IwAJQ&I8OgVAz}+qgw}j<t0h;fIl7*bomfQhh|LD6YQ2ul&y2WYsa=TVehpLhTfyxg66_9cPm5bwdXIICPlPD^H'
    '2Sk+B?-<u&Rp3p+94LZE>!LWzDaYTgAyYj4>NZ3uJL5vS=7HGhoS}>>wyMamhJ`jW{$vdD7r_&gHs$kHDc9DKixs$7r>k^_!N%7b'
    'W9byJUwOME6F`dva|=8dgM!G1S7L$Cp)Bsm`_5k1w(T?<`p1hGU5fZ18I=G5te9~l8qDuzt9ZA;Rb8-C`dc4nCH(MV7S@qT$0pUM'
    '_@r8=@<m{B$DG&LElg`KYBnMm84{eP@m_=uCQ!!%D#wOmkgeh48gEm`tyc3@ZyKAe;@>W2E^Z#a*xh}8*l0HE&F59ODk-8Md(`%;'
    'mn$qX9bNYZ_gJI`B@Y8yxc`h=2B7aEUz@}o1MfL)5`vS35ve=r&5Ue+IFhXiVzbMbO{gJHjm0-193@R_?CF`xGjm8ac7(!55UGQK'
    'Py@rhhh}f!=|}U=9=^s<<{FmKF~6JmjHxjE-lg`n(e6k+ezvb3^Cs7NoUVrIWK!SbFuFRr{1r-4L{D%Nx>?zjZj~}<l$OCXu%epL'
    'CKW0Fw&{xsQ5AMb#)N{Be(Q?B#jXNuNuj=Ko0QeD8WL0GfFS>Ibe}4L$K%8*uFMm(r!raPRXKZJRZdLtvUZCK<`B_LeIiP;K<Ed^'
    'ha2F+k-rPpsSqi(q#J{uZdnag-;{EYX-l9|-1&l9%P*j(q|Z97ngQ=FFsfgEhzo91*M8lRKkDSgk-1mZr_F90z6gt98!K8#2TyVK'
    'T!I$L$N4noWL7D<+R#N2#{+^q{9~u}5$6JzyIMS%HQSmw2SUJ254D>8s#ZIDt;25A$>Ekg!7R;?lOt~^bQbnCthSx!zPdt3=jWDi'
    'zdSy9dvf~PQ13mzSPVG6Ko-UG_sMI>t#W#H5r=z?M)_s5m)u=0v@%llG%1=^uzz1awmwl|#pn}&k}B;8fb>zqTcEdZQFb*ikKUah'
    'oxDCx-o3v%x-!#Aj$XYxxxB=Q8RQFPeKRd>c>T{u7Z)eT7v<5noA=q$g<?Z*!RUy+PflMQ|Ks@5Y$+4x!im1VID3DdT%BDVy^V>^'
    'ls3XFGUmXJpn{M_31Nio-yL22nm}PEY7YGX(^f+KtGT1%i?m@qAsUwHV>nT^7EnR&^&n_~d_DL{)wL39-NoqITvunZQx%7-_waOb'
    'J6S=+T??UE*h8m#4SYYuyoPT%K;Cv9<kM~a-dMBY!oXUY>d|;>wgQ~6`mdeTw%4v`V#^W4gM#x#2XP@X#`M=7^TcCxI483g4oY;-'
    'ez~3*w#_y&#OB8Bb=kLthUkPqoy|ss-TWYZd5OJd`f7L`Sp`4?6##jpfK8DKH26FGK|F$z26h{&TaT4*A}e3^wo(2DEdgs@1K}>4'
    'aklwh=_HT|r02iS`(UOuI3*5KgFwZdNK?P(1<wu|&4Q=TUKF)86sc^^zLbM-HT0*TWEqSEtc0^3gi6UlKpjjQk6;h%Ze|&vrZto1'
    '?S*E*xDQ3>*83GafO&ZG1o|r>qRcpsl%V8&Oki~wWmol#06MKkFESb)bVU(%Q}e0=Bzb89ZU;9;oI=KxB^l4U{$p?i1?%ZnT1g&4'
    '&xezAHJJ@oBssSziUBbaIH#l-DQ<pKx<VV|v6#$K463kkEO#@iJnWJc%6(qUr@f`nGxUWI|Edb?E&<I|4ja{OAsbBsJ>#iXYmY@N'
    'WUkdMZL-Y1_sAmqbOHuvoMJONG}y{CVAe4U>pqlgex*>5KP-^r3EcEa!^HJ(mLh19qEOy{PFk8^d)cCxkKZhmuNS~~6_>nO{x;Jt'
    '6~EUx>pfI7$Aj)ZSY#kQCeltboZalbJromOw3>S)Cu~{}d=PfGL>4$4pYiVA!x#yBJLR53Kkl--;K6cKM+0KW41+!x9Kc75=2UI-'
    'J&&{O8qPe!uZ0;%4!=2eR1|m=#A*&G?Ol(^&4%W~13h3_Q3WT?{0@2WZT@H-q{;u#l%6uX)aZ6KaBRM=>O)A|^q3RNXd>3l3opd!'
    '(YxbI;OSL4TAGiY0uU0|Oge@&9fn85T5afP`wiBEc?b?Pb>K%iqsq_y`v8->fJa-wJoRk_Y*O~+BTVes3)49~vG=`bLf$8byTDXE'
    '@FRm+>W%zYkFWybcQ;Q*Z))@4Ic};#a~nTtG<KU?e3RX(hS$q;K26sNRjtJwwA*dH*WU|dT0^*j$it-A%lGZ7N84ek6g-L#Yz=c5'
    '#lI!xvo2skc9{jiq!NTa43nFVkdrIwyPPRzj2rWR2@fMyM@P7iT|(}FkumZrIXeg0^62fqnc>)d?OOp$og+&;K$hrO0zkx8`NNfy'
    'Xv^7}Jp+^w;q5MR8OVLH`|LS4kJR5=eTq;B@C)CnA0@NxuwpY&fL2*y@E_>TD&{IjIC-1~Fb5HIS~biB%qepJ9GGS_R<~fH#f6@E'
    'p3UZS^Pg=$qJ6<xu(WWcnEjeX=p+{qE=_~kXo8`&<H=|`q-0fSvBT&PIAcsM1yHFf+8LRYQ;SOXT1B3rW(9tF1+XX`Rkz~svINsl'
    'G+E5otuqvLvkrY&oSte<0&9P5#4}FokTBznQW^<$TiVh}YzYrH=|ehL>wDpscQ7&#WyUbW;gii3z4K0Q?9qmwXa_v&_Xo=GXr6)_'
    'o{_uCy#CB9c0O=c?oN1d{M*U#-;d$=k1vj{&MuOZSI4JUCs+SW&X2C%z)^gdRTkFR4C(OZ<FVM3)pW8EMxZOtGPG`FkE_*rk}3sL'
    ';xN@B^{jd7D}cjl^&470V&}Nn>Vj9mhuMd}uy4TiWEDF<N97_gxET#TvPr+v0pE0h(U*Q%je&UvWDUdRVk?NM7m!1EDsTSB=t~ch'
    'L)Mw43!^8!Zq8%z8nXR>vk-LjpJBC)4|+q>Jgm!4@L1p$x8`4~&qjB9Y++=JnmMZ!=JV$G=v8Q499a{f;?dfhtStj=ZQ%e$&jRwe'
    'wii#U`T(0AOsW%ZVF?Mlv8%u$R*-N9wHBRL?O9h@Je(T|ARqRo$|OZsF>y{E!WY#~D_fWv6}KPLo)U(l<#|hvQH8(=5bLJKov!?r'
    '+9{;;!lb_xujow6jO5f_p)=@kat&;PIP)-O<-3jh!(;efKb_rf?Eb8y%iLgO5D}skGBYXHc<Q#so>&M)_3J-EaQqGFi>IcGC6>RX'
    'R9R2MDmto2zYeu#Y*^HZdhL3`TS`5(WwLv8@Hogi?;vi!!DrR+-`jZ(g-@FMMQl-lV-V-KXZKY}1TB7hS-=I@X*0mO?0^`>m)?yH'
    'cBm+LZu9Z#j9Qtiu#>^=%I!1nSB*~k+`CO7S+GiJLaClqcBaF_!w8c_6?}yJx$S&4T2k+j<*&rSTdk^OCrF!8<P62gBtH$_k4^~J'
    'Ff=TT(uqBRXQk7zUmB=@)X*hF4gSTf)G&pIPrPh&Lw7S1(6UEmD_j|EwuXl5jk-D7tc|mwA=4#7Azr9$4BJ>Yn}DPmJ+>|SyY0&4'
    '2z+UY1F?yev*?KOVDSf>32Sgm$(>x{T}N3W;zfHi&T(tgLP~&>&4pCpa2(kzXXuB`sc?zwXerRa5ER>%15xNUFn0WZBNWAM#-qoh'
    'aF~VO((+)GIOZ9vBT~NG_L#PFAcn8MJBY=ba5k1D`*Pcm7L~EVTU#V^WlSuT&1+Of-fYbThVqu~BA1`AYA+0h2q<Zh3X<uSdC>^o'
    'D;<>Jy(o-LC^~%=p+I=!*jy<aM3BGH5DY_efbcW(|7{gh(CN}I2wCI+g9pU}JtP=N=3pa&+&t>N1tclaBpLiG4)*K)gZ<$MZGvUt'
    'LWWhdWK9kNmeaC-)run`L>LNI%ib(S1Y@=~6~Oox#w*FrR28H6Xi-Z_DT1j&l3pKNG0p8TNENabf$@8OcYQ-)kSr-kxY74UEfj`2'
    'VqOGTD}yX#y{opzlV!T1=Z*wcSUrN^+pgFU2vU}5EeSp-``mt@GV171JwTd1p0k8nl1_-B6?5qjo*T?>XbVmAMnjdqW3qw&Nyrrb'
    'BBGFT{@Jizn)ZEqXXgCLh=lTh+{Mup9qu-E4{FUut@-?_(P-iSJ;i@*L{|m(Pw>_b&0)Q^1)EekP>?<^L6#^e`nhk4=mF-{#J0FU'
    '>{DT&KW;*5ivPTWR1E#ptW77n*{wHhgf=>6GW9m(rS+!*>`VuCL3V`o;dIugi}oWIn^(Z<X9Ml{r_dMsfDG?l{sXs#V%aIi3J)W)'
    ';WByFys~-D1myWi>)HI7UU&&+(&!qltJVffxCRY-)#0X(#^ICQw$vmk-CC}H7fQu9xKK+>C`U2#hB6RsP6IF2Hs}pLmL4ScRpiM$'
    '_^6^HZSg(KU6H8}l)qD|a7vMs8x)A@&}oE&(%)f`{lJzTqI(r~BYEI9g`i~}V#1b`Z@{2AKg@Dgk*?s<h1|cbd;^)4H!PRr@PfH#'
    'k|%?BE{`yYf|)kvAO+~oe-04=qhaL>B}BB2^WI!MNnWG2$e(1l^c*(93BkWPrbw7ax{wI+v44e2BS9VvHJMY`de-D2N&V_;6Pg>h'
    'w+mNQ0r)TP3BJFtce$lUKc8J(g~eUxr%(2w>`oxdkt-}*5DiS<`Fym!_0UONj;?5;WyplAW@%$jsx5I|CvF}-_$Y8XdRK7#hi!Oy'
    'A7!)A;6@uzvdbQ{ZOP$a2b{L#`!@0W02;^5k%i6B%)pl2hs?dR@RmzuQ|g4e#ccKEo6T3Xo6#4y{B3!%@au=aa3ZU4Q^5a54yBZT'
    '*pg3CN!h9XcB<JFB>Wx<?y4d20E%T??^Q<1ZL>&^ZAw_s;tY)RiIM!ZO@)$ud%1Bq0eJkt6CDvcEkO6!odQhGE3<(zY<*RIx{u`i'
    'k-)YHbbdW~`&L1%6`Ck`O-WfC1Xn6$@duvL&@0iags!bQagLVUf)xh`1WM#;GyX(26Sex&dO$`z<KXD!uL0PcTm_=X+wAQ8H}Si('
    'd62aw7SLAe)iOv~>?Rp9xS7%xxp#z}_?2AIqRbaMJ1zQ4P}a;u(qm#Yax(6H93`SM`W|J0=MV7!&4Ic4IgmtCB)$a{L)I#A6oH>5'
    'N<9sn8%z5<Q21<rr;5SXDA*ecoqvy{zvY!HxN4j76HE2>!m2yDf*Xam_v^<NHObhVSR{(<jdm{Y;>>PKntj`(ouCoy-r5u=MO;79'
    'I(7cl(rnF?7X`OOI--Cdg3la(yY((9`dqMMovhG=MfpTj0>`O*pIxO0xrW$Z0?NVswm(nfP6x~DVJ1Z@<45R&MJbETW}hEj0t?1@'
    'E_b`#2$ed|A|cU|pDvAeSqEevG#Ja_NJp=aPp<+<<!5?joh%ok-hbXm!>HNqdbQp4oqB8yRm0OzJ@YhFd-X<Sw@dyghlYpWFYh9)'
    'VIVdEi`6m7B#EuVKMk$JN;*=|CO|#oXo*^t!A(%mqs=trN(Yd=U^<$)95~hX1CuEeM^Iq9_j--!KZ5coqbLqg%W(D?PTG;x4}WPH'
    'j%?khgBwEyNIUT_Sq5s!dcak-w_H)yJ8q4VY`2lolT|Y(xb4bvDQU_V7KJ^RAm1w|3iSYj+30fsIaZy{&U}wnrsiX9cj5KOY%8a}'
    'cNYZ(8{pfuDJcBT?Rp3xJZ*x?%5WM1<|nohd+31*9^{MO0I+ZN?pc8#?8c4n+&a*gZnImaovMykEKGV@RMu`Pfd!uk)+hPVYFa^>'
    'iFP+B(K0MfsS2%JQd)<q9%VnbydWT3j39bbz7GqLnkNfxhX5ek!rrdM0a%)Yv(CchZ<qJ4@!q52h;{HqGvI8u?k+w+pXdR_*4jk)'
    '%GV`Yweb#i!m0VC7MkZrv+l6`rMQ&A-$f*K+C9-GWI?X%Iu??g?>QVmLO7y#K$#K_THoPIl(5rIfK2ZU5XUz8JcnXHz{^`R2P3q?'
    'R4_yRFU$F@<fgCS6OfqD(Ng8E|AOCMU=glLm5lK)gtd`3!1B+Ike_?$C6%`r-<cD~(v-~)vkCY`P+fsI4wK}zH<>|+0jTc_KC|co'
    'T|Zi0-`yHM^BjJG;$u<o4Kd6cA7kPiv$-{xSZKL9h^rWpVXx>5!w!xohOdVF>nP@yH>yeL<$@MmDou3*bI&!yS_Cz$Z0njvH>2qS'
    'q{(~%#+^;Y7r9a>d7i22<yc1->M(}I6LAUe)jXtV?4~4jX{XucNu!7T+|FP$`xKyGbHJq(@ZSD1)#Vv*MrJOCX|LnK!o*U9O~_Af'
    '{;u1C3N3OCxx9ypFUQ~rrfMzdFI<s_{3ou8My6?mzg<lSTe%dU)1gbKj{IgVm3vGlpc1%%S|gywI}qQw1MF6=w0b)?O}IH~peR3R'
    'qy~h^{w4a0@@rcxM{qnf(uZ)){QBblFRj1)_`}X!y4>kcW;<{~i+cl4vptBQfd74oErZ@FxW(#{GYB#sj(|NgCuYtLILKiXnBG5*'
    'px6>sV5M=e&gTU!D-FPR=IHz+xjOsx_!ReOJiQ;Rs3ZsGo;TQDDobMIkKsKRprba(B8>uy9QiPN$DT>%$*i|XZ|19Xhl*tm=d<}T'
    '#Tvs@%_R+JrKaDL*(Wn$r~=!Y!YZzpJp-(U<NYv0COEyBEZV{A<Et9h$^<jtY%rNlsMhIH7U89FK$_pX!Rgzw^B-pKQ?6zSl76lB'
    'yV(n@6Hicq*DPhJ8H*_`@2Eaxa1=1xOFc_@PJ;tiuIe%{Clm9%<hJE%LOeeUX(cN$)B9iSLixWi;Ng?`2-_{@=>&>^K(W)oN3$u@'
    '(eQdS+>!6$bm@@c`oi(TPUFmhl6;u4H<DQ~L));%xm$O<M}X}06B{3A4t_G8Q11ISESjnOwdo_pz_{S#RXw;EtqcjEDwK9_Q+Fx@'
    '23Zd=VwF|@76gE$3{4AO_JD;)M_WT^P4nq={uvOab_a!;I@l@^s52A@#-RL;P~>91yf)CfTA2fc+OrS{1oJR3JjE;_<|(Y_KA81j'
    'qXPzHgVTQ>4a_N5CbPlx4$mJ2G`Lq}|K~F%{YKT?w&@)f{bgEU`Wl)IT+Z*|+gk%<6FBIj;c!C7!{6f0raJ(z1`*u`3?IWgvl+5H'
    '%v5qOI}eux(KFPTo{0l8y7(FzaEIP=iFo<;X0!Q<#(;}2Pnks92VBCHe*qSpPWtvY@G$lV)Uvlf=INS<H+lo^S74-)SMuBTu~dKF'
    '%@+6e7h@Us8#zn&)2z$=u<nKK(Y^cI8}M#9HB+sl^qPI>Zwo)<D+3$&=J?_`h=UBpW#VZG?uXgs)!D_-YiNpV0yYb^+885)o$LhK'
    '$(akM+)m8#B2IwvPKIQ>IzD>!)-Z{eTlX}aqy}vOT2fWMq`S-0qw~u*XIESIX2`d>2Q|50)Q=HLKN$fD#;`XJYVsbPpPP=uS?|-N'
    '_Sv9<1w<j;ec^N~A7<wlXIIBBA(0&WYr?9&h6m60M*D}u@w3K@{o(U43c}~j=I~%|cf5P>tTCb|d%K6t!`@-@#eT!I`KCMj?d<LQ'
    'ciflR$K=!J+5PR_!NJGb;m7B<x1Zp9c)o1@J{-L;1ZnnV_jdMT3B9~K`bYBfKd<oXgZ<!1&}{6=e?H9K9=|?%`OgF*`Cwtg=i_F7'
    'Fl_EVA2fFR{TF-B`v?1byL&HQG)KMu@UU^X|9sRud=}a-FVEgzyu?DE@O^J^xc_1>-XHIedZYec^Kd+Twtu)k9t`$g3=hrk=J?=6'
    'fB5{xv%T?N|KLSq_gQbR`K+-!Fu$KYSN;CG>G$;Lt?3lbjG+#W&c+f=ZVk0&gwB;z3|~D<Cxdhcc&Qz((Zk$F&-HzNa*BINLP@Br'
    'aJGW5KX}&PfAQ>~KiGXXY77tiqvy}}n|r(c@p#<aKiu6t95<VdgWdk#{<twd7{4$}9rT~~`iBS2-50%{<iQCE;(eu(>Hk@8zc=Xh'
    '4iEb;hR>V*;X!jehMj5d?GFYAz1<hP<Nd=I&!3H+A0G4%&6e*C2QT`E`=h<R7mY!GnC+i@D{S|pVSjILwD<hQ^WDbSZ1CRTVAMO<'
    '8$NsS;>EZ(>h0|}pN*fr80_vpI~Wa`&Cy_g_pmo;JR2JTe9?cA>Au!He6hcKuz%RtHFMd63{SgtLECQ6UL5uZW_t$v`!9wsMuX=E'
    'hlc<>29owh<HNBz^5*!k|LmaIZ;YS8p6-suyCbt-<LBnwdjP2LzvQBR0rIkuL$&=>f(z4>T7uCLIb*O!BEg9Qo3+5Ych89Nr3S7j'
    'ML?{sj3eK<o(H`dl%J$rKQ5Ss<wvb+p;S15pRd;ZCa5%wVO$9#xSuT}rUy`F=d+P3XKd~co(7pzR&EXuuvIiV)2=#k;FauDtM!}F'
    '7mB~sy-7Gb2TM|@B6rNFyb~^_hQ|rJI*yTDc4EpAHYMjidWDn3;2d=AtLpvbjS~O9;pkHo$dAcv?tY|`KSu7?Es(Kfmbxbcd6JLi'
    '(*A_*gS*Ml{kYaY$jOj35ks>iDVUD&3IUf$KRbQ<&)|OtUTt*u`}AihdY(4~qh*u29OE91t$q<JRYKhd^SFMQoLpWUzcxQ)=GB18'
    'jml;Oe~W|WfsdyR_=w_{!?Kjz=7vElI?P~*%Nm=ths(YJKGe00#m55pR><euyKVWKy6k;6OQ2V%JgsCWV&JuzT^A^o%$L<5j`cEV'
    'RR|rNyqOx{lXRtj=}ptmHOS>Myo9n7?2Q4U3NWHD@36T3N1#ew+VkPFVbFomsjR{14(b}%ioNc@f`1Dd^Ty$!IyZzY_|!`<7m8eJ'
    'g@m%h<LhE}(Op>Fe|<~yx%&(6bi|y!c{*99$<2KJF}4?+ZI{#nZM+uSU>yj&2p-ZgNEDAj6sI8O;)6+=r1!U^$!ujn!p$8vg;8WU'
    'xxJ-WKD!UY$#`spU=72x$}C>G>l<O_hA~r=L(k@pOWzU{C+jlAcQJ<`J#SUuMVA^_*F16E{Gf0hUFQwggU#z`DIUR!!kg7<k%q7r'
    '#qX%nGrhW*rz<qS8}adLh;>5Y5zvI@?qR)Q{<nz)qSXw)d0-yCxw<;Pgi-J-bh5Dv$^jA16hM`Rg**{BtUxe51`7Ilz8q#A8>j#!'
    'h4*Z{>|KM}0FI86g~{L<z@@qcOA0RxcfzWs=BM+E5d{@id}*T&%aeC+%-B$9w&iHcl3z&~b&4?yo+Q;$N*>BLffUR0r-EXu8X{9Z'
    'M<H_x?n{C4SrAg$MX>BN=$3wYYvhgO=cCKx<o(54I7fty*3J$n+9jT?ZU~_A(&GM&B(%8s&*`QiUSAxYzxkhUi~1i=@9UHK4tL~@'
    '09t~rg&^x=WG5_Q5a~1iKn6SPW){F>z<&y7ZWV7ZZ{UBj)x8Zp*=uCC1&G&Z>29ZhOaE>%9VYZP3rgq9`Imc!p~_ctjWpO%U0erN'
    '8k#s{5ypxFh|?o?9?CekB8nLWpu8}Mir-10WAxqexE|~|Kl2M75(nYvM;Un7TagP9pjwzfz>%O>g;Jq9c$cMuGOw@Uk#|rncRpt4'
    'U(Qj&sa@SKM!>E27ND*pbv}hh1mO`@;VgOk<Vl4`0%T;i_nSU5O6h4<tx~_Z*NYplT(RF5$cWri7~v{iL!X<n{EXEPbc6>oWB}4-'
    'X<#8fj<=h@4E*^_GhlX>qjUjkt5%+ew9}F{b$XI-iR*y*!#RZc_ryHeZjb~z+1uxviuotQ_}LF4P%@y7O?nJg^La4sEw4vmK~GTH'
    'jGz+02XHtB6Bj2y;Fd6|984s~80k~2uGt2Pvn|?)9G`;YJb)`f^IY$<gsam<`1;Ka#f8<inhS{u%8GE}_$ae_FwEekMlweq!4iOI'
    '?>F{ar7Q8l6!}Uro||p3gojTHW?}IFN#-p9vd};Q=J&8eXE#{N9#dzD1y1)xar@z<cRe#a#bjU_Q*taRIiDcqi@~Hu16S)}*o-V}'
    'C3vbaUDcv}V2@**Rt*SHjXYy4*d*lPYJrHOSaT_%B6FC%1q7F+`my8%u4V-iAnvl;sBHBQg8`v(c1d{)1C_&2V~$sx0|9`m1U$;m'
    ')ZW0mnbisgm=1Sp<eFPw23vQGMX2Rpe1u{-t;u(_p==FYkV!h3nOV*TJW}Z<!j&vdxf!PO!N<|cX5B09S-Vv69cQFcn=flN%3kUt'
    '7p0f}?*Tr?O4!5)mW?3!MDr1gMSOIA{=EzZA|Ogz!90YF<T%u)LAdj&Y52iKx&t@{Y(G!cOk`|3svS_tNfWVDR+jV6riFp>(NyMw'
    'bV{8dH<^GKj|Rr+)O#Hv1k*eHoH#?QBLJ9?8Z0~Tgj~6om|WiU?#n^etOd)%nZcsnoQq{4Ago^td;f-VDH2{B%K+XTF+I5<Bq}5$'
    'shiKVsP00c+&;?Yk^Sn7{Dci@UK+d+jHjc~${JqN>3o&8+5ELI%=#!2_eiuW4<{*l;RakuBcOQDR43;lD?b}<vdp+wdF1@)C8S@x'
    'IKDi-_>GE>T%4U<6<;up+R1i!_3r%D$ptWukT=bU3PzwX(%0M|6i=)mJ#h^-)!YJCJdxA{X2zgLaPAxg5b)R<oZzG|N+SptH}@$f'
    'Bvl(u%g!rQz}_pE6az+Fg2jMz85r$h^%{}vDdfKk#5EfaCT>(cg|hcuR`p>UX#EK2;j&XU@^r62^TAUuQOwdtsJuTmTTei{1ah4='
    'yN2G(ZR@qucdgc}!43Rf3vr2~^lHYeT*BP+6z{DjV`ID3q<;*Kf*V7JYpfzdgSey2>cY6G8wUB#pra)i^jBsAXe1DehU*$r<O12Y'
    'lcy)Xeq7`}fIhO%83a2anaUty6xdnYvw+l`_#Y}C0Y9kn1pKv{e;m!qYAA#rKtgkHwlaha+}`l_$H{CMe#`0Mcw$Dhpvl+4M#1-t'
    'o^<StyQscuhTcn91HLfVH#0ZgjAoAwQ9EcgPtpK4q3b<z8_`|UGwfQ|K%!v{Cgxmu?w~92T2zCdg2tL|{0+=^DDAv`^_t}r&<@Hx'
    'q^>~CzZGyDB)bFj%~^~PMPaH=yK_;X@_o|Gs#&C@cObL4YPDe8Oq<|o9IWfYCwF|6oq3FI3wo!b(^(`=F%e0KHvL<<a)4Bh2IA<C'
    'ui(kjo3RF?l1}fgTR=9Ht&N<`me*)DtC}w+!vNZe|4SP5Cq^QiU0)K%{Vn(wX6OMZ&4iPp^ivT&V+~qlE-+3fY|;Eg(E(mIvG|N4'
    '1q8i~`S|O%D*e{8&#7efha4=O<Bm)Rnr|{csXeSPL^3GrFXoN(1l*2fDI?Z!14EVVo?Gg*h!!wejFyRMnQ-MdwJMZG@NpFo>V(DW'
    'CZHM`1MFChM#JEyTf@lQEy-8OO;H??sC9Op?CSzjlb=`1pkZ|2V+4!H4>(cyZ_P*!*J0!~3La57+ol2mMOnF&9?7uG;8*IU+%tol'
    '>3Q}ToqFwohL|Eg8;0=sY#6eD;qD3GkT<TOp3o9Vw&xJGhF`|aka5uI5dfT;-(jY^u9{<J{F!FwNA>aDbb1T<>MLQVSNo$;dr|8?'
    'HODfe9%s-a6>?IC0^b5h4#C;<(lY7v6I*}-j(n|`XZYjAXt-gOxEySO3)1R-_#Dy0f;Ql+;5OUUSFkxXyrkRdOSt%6&IBb}eBxhX'
    '1YiG3+)h&5H_OHvF$0(iSZ+&+Xn?Um_6%PiUm*`J7xw>4?{05<%ljC;%SrmgY}cmII|+WJLtu*(?&LSg!VEG7+_+m5o-l<vHOD_i'
    'e5#|p$3>BAhLf;lkvPP+#%fRmPt<ta8g0$!ixK@3=UJG@TRlpioblJ<u1L@2srVjR)G{B7Y{1M<+$>dPfzxrJGC`(*%ZTw`g=O@?'
    '#(3TUb1_|M)(qj&(wNUTv*pAH_#4kj?R92btW}agY=P;}ZZ~6=G{zw!&uufwZ81t~_LDWopw}mXulihK{ll!-`hq6@!NdiJMd}GS'
    'rr0|)HKuaPgD(=js@T2+Z440{!^Yi?Rta2MIN;uDemfahhd$QDsP3m~o_s{SDYSgf77}@|nAn}j!HCX8Do(>jP9`1tQ}AW;9I3#^'
    '7GRS<`!P73D{MA^9KGlnVdR{^x{recH(ut!-0(iB=QrLHOM4_el8S+1F%5m|eH=j*o+ubYK|=;PQ8<9taIKG?z~X!zV5kClbbAa='
    'Z+2g~C5$*D+5xhJcC#ceJk(Di288)1C^k@SF@f=pLGgYe&5*~&Rg&N;PU_CJBDFz0Iah3-Z*iw%u!FFthF3Xg5M{Oa=_hdK0Mj=H'
    'j}InbIiPK_{EQr5MmvOu=(uGJ5OA!ru*Qr&m?<qp=R0=0u#ZGAjtyQUAHAY3=uNH%dh9yLavVH@W<>ds)7@DrmYtLtmy$^13(MdY'
    'D(BRgG$%bIdp4GhXcv(gkar_H9*51u{z^E^s$@<a@uKELPnbVOyiN1!d}U8bBQliC5#&0stnQ%9@J&m*Kw8(0ntSO_Kr@FxKB!Gc'
    '-gj|^%?y{7ZPaOWsaIY{>2|OG8dpj8o)+reVLBoF$mJN%B+|h{@D6D?x<&>J-G~%W*yqI@XZP#gw=fEdx<W^UYQfa#eU1ggIq9K$'
    'tCi_?G*ocE=1SzinIa<@JtCqShMDt0(aQT~^2aE-?t_+9iCWa6W8Zc`0}{z{_%4v}sglBwXK3~^pf7cTB{-cFNKMOb2$%RMWBf^h'
    '(droHzgHV~zaH$viO@$?)Pl`s;IxO6#o=@JmY&Am&BJG*ua8xe!q+?}V4>hGJgP%rHJ1Mg{|8`1o`+{@8E@E>j1Zvh8l$m;F*EkP'
    'XWuAph=EUY*VJu^Y{qy56<SAyo}RKbrd7v{+C@_ktdF1DLGX=Qxh-px*<PsSpcb25C=`QH$SETQek@+}Cw@$2ngXoTWI7UF*1wB3'
    'l8gX@Z4TgtmfHs#hxa|?4|mG;knIwbz8ptVv5i=*Aipy-)PAbmFSLNF>6C3-p!ArJQ4a4qiS^^?o_#Vg&yhz4Mynp8+A90y$fhd5'
    '7FS2|(IW@Pth_2t>?<+Eb`*^=O;H-eju3GjI`78LUJI4Jo$TI3CB(3VaR8<-uc0Zx?mj-DIW)S}ZJRc`)#733^=`4ISzZ<?nfZHj'
    'N{G|J1eQ3y*GN!{Gyy2gxb0VD>J$Rd2+?HAQ*?!`wKIRGwP&V~aa$me@pZ}O(`0O9w$T#nQ^Yb<#BsI-FPr8iMM6?4BX8B7(T-tM'
    '?*9T+{`d?QgBBcsQ+iaj^vJ@zgz*mUgC0igd$F#LX(QSQVmgP@)xiWmN#~$*@2%{G>j)Wzbj7Y_RQMl&2PFA<6<K~W*6pIA7bBzm'
    'q}G525!ndTEF1t?wF_97SweI#U*_WV=z0+nSw<N4%K}6*=sIV7+qhEo@m4D};Hu@FrvYSF&YCeY=YwOY)H1rRfV;7h9FDB(QDAR)'
    'ENlrq7ZjsDVdCmu6jpB~cFYaK>>G3mv@d2#??t1dxrCm8m6xlR6<D=J0U&=E)JIHIoMWmYb-)S2NNgcRxli;bXvwdTEyR$bjMqLT'
    '4i#UJ`SLn;dO#%#$647}%|44X;}TSwLAh}u9#*PPhqL265`Pr6O|dR%t)7XazLVS0t>Is&srN{AZ><&LMI8e>fC*Cqw(Iz>#Mt8*'
    '$*jr}y#-2im>nz$=LJq6vbayoUHzE2t(!r8M`azO7(?GB<j96=4=JGmV9$>LF+FoTur{l(gwUPAxdTI8Qjce*;ty$Eypo^>EM#{O'
    '**jfLrc<bqoJk_!Vll9v9hQ;BVVOERgGg=o3`Y#p!22dZog?`PvlbPYA1J?T1U!nAM~~g!^1ki!S5XPpj7UI?Jid>@Z01WUHIEx%'
    'n%^@E3v5;0EZYo*78;jg0cT6JWpaIE9)Uv3EvK%Jf@#j(5~EDxoXSRwfV_J#pJ#`Vr`WHp$AGn<v2EYpJ2d%QK~#_os4<Z7wnPU0'
    '&f*<U5ChW7(?xu0*bijQWQy(~vyhZ4pDf9m;kIi+*pu;h+~7O<EO7s|*luqDgoi*Z5^YSyhxe=;L2o@h2gTr$8iM^1NO=*dIZ~^@'
    'HsBD&h%<kvb76c;B&gu1a7KOKy<r^>xwi{Er1?PM=CGT!U#<OE<}sT?CHvgBw1kd^9GqC6XP$U3^cN1g{14RglCfN9JA28|=ZXTr'
    '2D<%c%tNPOwK$n5E~!`}78WW3JLnS|oZZ4sYxkfV3AvYvIchJ2*-qIK=3;}cCTIDj0K&anjpDE2U~!kA&rC~vY2eP8r>S|;EOo;{'
    '+LPS&O`|^KI#m=Y?0&NYB*di1q)BVxTX`88_>dU!(h<lG>aAye4)49%au?|KX*8WL+~q2Y9nPA(sI6w7_~QCpN$yr<4zXan5X$2W'
    '%tIuJ1lKv|N$`iMSoaY&dwKYSq~DlgBAp=xEt?snNMbHxKhhdz^$z|fDVZ6~<zzaL_(Ye@C1;scfp2atDx<5RrtT!H(!Jm`n4R^J'
    'lm!`LV{>n@=BC<ph++evz6E$TP!DwnLo{BD;T6FqWVBgr27MpO3ywYq^@<fEgQnJruTz90e+ecSGpogXIvIf9jRBU>%+~DvT=>GA'
    'rA`zduo@?8bKY%3Em!lwd<uQ#El{rbO;GSHf_3q-H$i+*)E@y<Lh#=Ta`&P96KV>PT<%tWQ}>2^&I~pj3b={&pcL%b6B)R=U#9mV'
    'aFPQ|3<V76?F6%M-Upm>jYRy{$5*VhAI+AN!40O7vfQSGB3@5cH+TKIL4G@!1aLgP-!cDRyPog#r}O>}WX}_$Rs!nnw0=FOE-reX'
    'B{LDt|L*^=_b%Q|9a-M!zj8u<>&i+bSvFumM7^4TljaKnE|8w-F}fOAIs!Ga<k67;H{<{P)_zs(dL2oI^n7=%+pCjU=hUfp?b^@Z'
    'UWr2B0@+|-*!VmiGL+KF-aQE>uGW%cCLAv4T#LR6La2`N@KMfaEN5!^)6jdiLE2}g5ul&LKhFF@17MjsCcsA7>JqXXUZ*-$x#s6V'
    'qpd<CK*oi)D0sPxL|$&H=~YKV(_US-rnxS**zuXcpoy$lC8lQr%h)mTZD<~&r^Hu=ou_xGC6ld!L71qwr6Uk-kPG&gv7f5GSPCd)'
    '?;4EESW<j&e`GixT?*s==(i^wj8|8eU@E!}I616PxCr7Nd~+Qaz{&^OIA;S4X%yC<AT-LkbMG;9IsWC0`mZ>*=<-s!6+1BPSZD8Y'
    'G=$LrJ`B+IMW(T)8rg?I>Xw%-%RU1=9Ht4tk9-Npn+Ca9gu|k^ACk`h#^zCVwwxKX@GZgH&A(|5g0%_sISHUb&c&6ZP%0oDF!T}7'
    'D{R_kYdg;zbm&>ebO%UMXOG(dL9Tn~xo3*AWqvjhx)#Ax1zQt}eiuo~p17h;KTWZ<;Nu{a8{9S<&&RAs10?-Xl+66}{R%$vL9s8K'
    '|H`&K9!h^wgSJ{n!xz!UnR@Mak)1c!fGwD8!Je<|=Ls9MU&0X_><S#tTxD5%xaSw*Ew3Q9u!YvMPrCrC=umKl{;9AIE8<1MjzG(m'
    'cQ`Kaa73;wnaiW*a9E-K2(3yNaxgAZ2SY&MLZY2H8Ct@Rj)wE5+2w3_9z-r{gm3l>j)won_mbgq%3@)z#SN;$((Dmr*>3s_JM<Gj'
    'I+JP#X)~s0dxV$Vmxxt1n}ux^`XDfK9T>_c<s9oetE)#H8J<||@XaX8MV_)`Jma=W9l0~;8B?JC1A7W6911r>GgWwh!nKX6fRP%~'
    'Y9W@WVSB&?W_v@S{Fdqfn<E87g_uLWh((>m{`93D(q}~g24-A!)!Kf#9h&HVt(4CV@6aEA1?wDe{1tV5vs!{gCvysgW@kk{0FA$x'
    'rjD9m`StX{9<gCc-6CB-`G#^xo#lh_9E*@-M}LykT~x=T@drDZpr2?J7SO}IvbqyKmmg%yQXIQ=p#XD&X`)}md<=4dreZvS%&KwV'
    'xkuKmGsapJnK2Y+wyGTU-$FffG>42W43yRv5swq6hBsHRx9kgwpw-05f6dpH9dEWCF8F23#Z|}gUFQyfqm8`i!er$slr8AA#f=b;'
    '8E~rufkv;KBm`4;g|N|Fw>xXf;n4|Pfd&7jG;7AdckcVB1I;ZY-|ZUxCJ_;ty5@aryxMZhPiNlCRHSC=21t|mx{tR~z#K)ZCuqKr'
    'OXyl+TfpIsaP0PExGjKMJ$Ib%A2Y~7_pGXX^a)h;DOA9~yC{ham_Y{R(`j|x1Qf<vc4>xJvsEZy_I}}1@d8H6<v8nhqJaCJ$^>x)'
    ';*sO<28r_7k8A=Lbgo-W=Z1n}PAQ&3jU3Oj83h8^s8(BYHchp`2wc>oSj+#FGbX}Fe#)f8zjDsxgna8sW2lQE>N}jZC%ET*vyZ@I'
    'M24ROB;XK06J+d)EReCmry*i|Pnx}U7enK6RZ`a*cqLNpiY!dZYP>Sy*AnpQ`1P6kD!dRNn$dlO<l~Fe@Ns(C_;%;<tr~CNc5LPC'
    'Gh}1TBi<^mV!149NQ<pTk0Iq-i~tOJr^d~MWKz>57^41y2kBkTt}iOQDNL&C0`)=@Vca3Rb3FO2LWclx-oe`B=C10PK@py@)2^=|'
    'p}`l;I0&v_|3OKMEx}-Vs^kP9#xXdF?699Z1b%Cwk%Ngx^^vqllGhA2`P2}7<}16!kFJ+LdSUn+-Gf-JXeLy3C2nfJ|KJq~_366('
    '5<hr>C(h5-v=@vj`Zn>M1exu?Fe22CkrFJFP;%$Fa5+Rr$~f8!De=yDp?A1;jTL&8HsQ-_frkrryabO?Dc?ZuQmMFG$DIeKA;yYh'
    '@|hvN&iD`#;N1zLHf6&u?l-D(WbT8uBU|<ef)}<t?Wc&R4SWPQwrV*q3(mW3vCzOHj%<Rgf3mY{i2RD3$Z)TiLoj+L^^FkS5+-8='
    'nV!yPYe+ARssBoFY-6Pw!ds4P^rP9;c&ov8r2N-mk8*s?YWq10z_hYdu6B!$ONP^QyDz$4UBoX(=$P47=?W5#{T}HJoFb42bAXP-'
    'mGD&Bc`5<`ZRv?EF!XN%m4ks*R<@*OOXkaW`45AX3>{Ngb2Bm;zYC->JGnhM8Qt%moZlaxkB_@Y;|G(YX?geF$(_mFqX*N`g9qjD'
    'cyd%uZ;vK-&%1YSAD7efJLU1w<nDvX<ft1)S#9B%Wf(r!Og)+0J02h1yMO=g{k!Ge2lvJ&M<?TZ-SN@!sC)OQd++Y;qkHF*yQW`|'
    'IpW^vUibL^`Ehys_T76A&hOsq`hjue?upv)Xv1WeMp&X?qSRE{H)jaAN?HJ&?E^7JTp>@-sHL18b&+7NbJcywRN-grj{MprT43lo'
    'OllvlX2yF_%~{SbO?huBND*`zWz>&@v&Op_1Bon_ZFaD4a|k#-e~gfqgrUs)x`~|J@>63Q#EANzUI=sT_vkXI4tGeN226><w^d6X'
    '>}VNpw1K0{Es@>?;sMB`($J1@9ti>?mh61iCA{N@01eSEY&Mbm4{krWckkr(os(cAC2H0gPPSEieE-3nJKg(7ce*EAcZ!+q@rTSc'
    'tS&U7pEfO5n+R#!Rn!m%)FB+TzFJ)Sf<5fwsgL)JJJbA8hAOJdRN+3n8(oGF_^hFIvRamNutsLjan~~`JE0d{$cQ4ks@pb0oFshW'
    'yFK!hRdw0}4(Otw1(E<9vOc0m%TC{$Lv7{(bXD9jyJjwFo}`DX?Gcw5N`6gDN@12jIIOyFh1t^I#@BTE)YR3>NTfT~>z$dpY859!'
    '%=Et8W^kKX^+3#-DSyiF&@DeX-vuQ^`D#|Z8|zftu82JrB89qz42z_^xw(wpU)fsd)^hIDgqCQhf?Z6?k8n4Q%W(9;0i8)4%BSrI'
    ')f+&oK%+vwS6P~{Ta$?TicLtJLMLdqB}Dbqb_}EpTvdKgNNSt)cxf%AmY|S}f>)9;TEGpFQI?5f1c=>Ww8F2>QeO-p`tNSH3&oDR'
    'DAd-L{;{~-?IvA_RwXbB90!9!h$V*3u^3@h66&>3T|u+m2vUOjK1ir6BH%9afchvxFUW2mw+PCE04tYkOS{K8b5(-z<1YmY;zLuP'
    '%MVS<^CcK0JhsZ~EfXCh?kLtr8-p_eLo1<R*N-9N)|fcQ&<n%wv~RrtzvLyl1h^K#E17}Y*e#IPofbv%Z5~d5qo2p_q-0pq)asl0'
    'W+hy&a$Z`y`eto6)Y+JhZK49kc<kaV6<PFZ+@5UNt?o`=?aU+zInqVl4oi@pynQUY!~9J(tHj_A_*K*-n&H_yXy<roH09kaRNBL)'
    '*YwxD@LhKt>ZdDVr@&#XnP&HvBdk~IBw4?Peot3lD@;TPmjVr+)U6UCKlCJeueQLSieJmsqMTD2a?Gw>U}F_Rdd)}gice+_wMiN&'
    'f&Ldb{Z(;pE(#;;jX!j@3rY3UR<sG4QvqIK$5p*Q_V=EyK*!4|-=qQAlG0YRw<T0GN}{~RP=w->p(jSJPQq*??XZ^9p|04tdCMwV'
    'nxVtOf)QBck25JXXl1@^2528apqzpX07FJ1Xv^}5p8rh1f_cK2=)py|_HMpBx8bIp@5OLnb>@0WIR$q|!j5HC#dH@;M7pW(JChPV'
    'u5T)34t5PCMTRixxt&axbX@k$Vt(}yB7Ci}k~WMJ;Uy1K&V!e+D6Keh6S?Q>Ip2uq%ego=ntO19AWH=%5H!_pHJsG)gVEtNS4%}k'
    '<iaLT*u!DlabKSI($1hhb*#&cz<n|&{3|51gt%mV)ZQn(C(?%gFa@J$eIXToy!{lGcw`#Ai9#qsmXD=y!Tf0Ge3v2u|IKs#PNoaM'
    '8s!AbxFQ2SA!&G8sQxYrsFpkKefw7{O5UbpVXcOv@O3)<UDY|NdS83f-%)X67G%;_Q>)=r@Xkr#u~I#K+<2C>^l3MS3K1G68A*L@'
    'fx|{gK!t>QI>~C2P{j3Xb#ST5RnP3XX%%^pRRm21&B|(sEmWN5R)eonG8}&|hx;yc@A(7muHtt1f12TSFT18(zPs5s(QeBDWXi4y'
    '5#e9lpe!R3CQZLHD!V6l?{`m*kB;t4Pev!@@txy4<@w~!$!I*iGa601qX#GVx<}L75AGkGkH`1Vk8Y3dO&?5-?;nki?&zH+jc{u7'
    'llyn>-oIo14e8tC)aItvk>T5p9(3<KxP5f*?)~ZH&iMRzZ2EBfb~!njOm9z)ZciuW$?fs@-t9^E!Tss|^8V=dz5BQCPVb+4EobOF'
    'WQ9L|aPQuO2lvP4_wJ65?;oFcO*MBX(+79T(NXvA^!WDq@$`6fG(MglO~*$M9^9SYDevCBe?INryK~zJZr5S-+*Z?Y(&h~7q@y#V'
    '<(BF~uUcnTsWJSzQtjLNinI6~%B}{V8CKPti_hyrHcLr<(zcz!LrY#pCtWa)#g@|j?AM+l+Vz)BzbD;uvlS+H%khJ|w;zljlt;(M'
    '$CI)=xjQZ&oZr1Yxjh|sZy%kUl=mJSjmG!O<8pFzbbjZ4dAmG6z8e`GxE<;cD?CrSlj8@Y(dg)2d2;{W$>{dz?)d2V?&xlL{-C^j'
    'e*6A|J9npMgO^8U)0ExG$x-*@{K4`4+edd!rsubFZP?NNG4^!d9^K5Col_sFNoEZN+(Sy$9?VjWESw}C^(I4e@E>$fx_6Gu1m53b'
    'nYXA)*pWlE=K~w*&PGJp&naVKz$)<Q6Ba}Farljz+SU$+#ocX+?vkWjDmy`4FcQp-LZ2)|Og1hlF)`#j-`@($VW#}U>~c6CZA`Cn'
    'LuDazC{~=%;n(KSNbkbd7DsDj)(5((A52|{d9L#{I9cBpES0k`XQ0i#fYhpyUC=^(2G@m^I{dI@PFaw<V^SF=($Sm&oAs|TP0Oj<'
    '!8RT6mOEOc{{{BrG^wkrINE=y7V0-?y(Kv~AbuEd_W0~!oW410o-<NM?(PZ8v`Fz5Y(Harm8Ui&O+Vbtq@A}{gN)`|rETWdMA@t<'
    'o0m8IgdPW0YnhuZ*6STDmp1)Oq_6^R(<YhGDl7Q?)i%r<+9yN1qz;1e%#<9Tg<(#lXYfLqw8<rKUQ3x0T~e%iTVg6^G9^~}BCk*1'
    'Ggn44rD*yzTa_s#XYSUC-SII!dgx_Y*O}Bch3gD`*^SIPD~<am<uj1LTac5(9s%%uoj*Y0OVv%Ht+tDSqaGxG*FJhFsSD@dCZZ0w'
    '&A_|yD>AR=G47>)g^nXFhH0{sd9ioiu>^`X>3c|)915$|U%`7nfKmElOEtrx$%}*rlhg0n_d5L171U3osGAQ9!@P!PI$S=&mhs7C'
    ';4H9L6l#>JB7`{6?{188l1#&~73kz&l>%cQJQQ7j!bcz~lSMkQJ7*Wb6$ysTV>yU<ZYY7m;#XkP-Do@__6pEYxln&L`;OC2Zeu2W'
    'OS`;^O~A)pXA0ZkHIb-UODpy=;xAGcPS&m_-(+kXM3w_Tg%r&X=)vv|XxxH0g&5XBJO#|-nwvyEjJ(bGIr)_}ouSRGptzNdM+*YX'
    'VIIwkRN{3ysCUq4CjBI2Qq%4bf2428pB&bN{T?pJqJlwAP#=L|S`QfskYlINSpv#US0kL9suTKdq&+hdQEyZ*IFPyh&W;qJbAyUu'
    'OC6D;l)s>iJo1Bp#I(x$A@&yVppdq?3mj|<I&S)r!{Ilay!MZC7TD&O;LV-FK}xy}Y!LF4Gl6@4C5<p?8Y{X0F6e;hYa%o*cRhx-'
    'eCu;iuNw2L-P!@+=CbXs&IC5BwYiUU_D8!D$a>zupTGyXN;?!VNczw&`Yw1i>8b<|^ear#f#T^8wn?W|L^|PRpp)ruRo1AFGwP)N'
    'j+!JfZRhy=3^s|Evw?Vgc6#@;A!68W?qvhdThsk*WOcbZ?}%4on^pRzN>D-1PP>uR14h*Nktpf$296|qkHSi2S)t77(3rsvgtADT'
    'hUhu|B85U(UbRKFB||Qi&RbfK{0j7<q+vbXAz&dtYdhdX2%@}Cxs~i>Nr*<DF-mL!GtpLwtoCR$xvEhe;n*ZWRq`uu=HM)`b%E$z'
    '4Edh2FT}Ae!cUTsNtCQZ4W2`|(XYTG1$+vNC<@YD(3sfD3&||bm&<jvUX3o%7g3IT@$~S8O2=Zv0d$6`s7{Jc$0WQ+*XFPrZL*D7'
    '$r0#m7~@OJW{`3@UZUJn<YGDl)Nanw0X?oZW@np2hv3C#TnGWLGp-~6w29r52;-Nq8@##ejLs|5ueHl>Y&}K_E)5l&HTbc;Kdsiu'
    'hz7GoW8esc0{`U%2NC3pcQ8UNsGoGi)2t)wnvm*n|Fz8=NuVtwpsEkJaZh!ZJ;;fu7**FzauGzEkrxKsd_pR9o=Sc4e@v#6)L<k^'
    'J7UVi`)3zg=if{&v2s|~F2pX&*KajppMMLJ^^R6+3p1H8T$5P+=<%<xwJSJHkW3ISazl*D6$tG>vET?Gy&(q0$k(go=G}Ybv$f#='
    'Z3Lvcy0-bl@ilFQB+Vau)!l^e>+Kr0f&~A=GzN+gkZrWTQYO|dyD){lquSVJ^Jp<`OYt^YE2lTf_<20VH`3w<X#x}J07F%}<LjwI'
    '&8C+M)$@T!rPm4!by8C7c>06}*b<4;xGO{j5Ldmg!W>B7BynQB(LoQiABf_9HlLVI)h0~}V3flwgvtC=aTdZ<Rw_u8h#3*%Bjs*R'
    'PHbj@n9PHLm{r}SSesJ(U#6R4#*n`;OaPt4^YYzj(a7;7UJA>kfl$F})0uDvA>DknT&;(YTLLcvv#P+?z$8`ugGLLsX%AGe$=tHh'
    '_3rv-_>>(xw>3@CS9MV@dYClEOH!9&ki3jb*v)=`ATJkJ-_kIC!E{KDYG0d#LNT-zn8yU0xEb>?UOj>9l46)xRn#^FH<>3jx=j2u'
    'tGiY#mvJA!ZLG3~PI1V;C{asa>b@>|M_|Y87<jBH9e>D__BGjgh~KQQXs9en3$d1tj6b-u{}phWep<6E_u+T#8>(Qm&LY-Zgp(-v'
    'h?&^aKXeNJmO*i?oxx1UzA_kUr%BVp>uv8U6wj#F_QFgJCR$}m+JR%V;+c!lNwJ8#K(&W+<a6fk+y+iZ$t_dkd6cOqF&(>jA0@iw'
    '+>e5~{<S_xU+0JP)xJoX`o6-&2o)ieJ4rc8CfZS9gzmbxJ~VkXtvZdC<j9qx$c~FDw%9D>?*EYWbLRKz3e|Cw<>gv~LYht>qgMq!'
    '6~pr-N|Py!VV|a=5aUvR$sMKlzKf;mBirN%6Y;O^y0r0L-^Ux4a7kTQ7VJfZ0NW-tn=NqGJ{mM*5L?)JCtXOMXNLa1pg^-Eif<B7'
    'Sj|p^qiU5ZULTku1{Nj1n_he$HPMQdYP#{JRgS!#y)zS88Sd!{3C3!*F-uGi2DHHr0fU`P@Ey{)ZdRE4T6mWW$bz|&3aL4B<&Nfa'
    '!|;z*fGK)8H`N26L-Fao`PaxQlVpRTI}tW3+T)JRJ+YitTUOqzw;!$MB_pIN5`KE}joH^|b4_GEbim6asR*ZBdsuk8h{2E16T;s#'
    'p;twKlC1KqSAx-y%)Abaf^;17MnQT7UAPKK0`jM$OG6V%B2q*tTLMwhD#TGhA3O8T(8&z1S?inX)Z3f$xv94?IH1Z}1vYO}u4_G='
    '-N8Ftk*$p7xz0))TwT$<(GMnt!)v1{;^*?S6<x2=`j-2oDSOn=)?RGO)mDCRg7H8QY7o1fZ-e4Qc=7xEUkeToP{75ja=NJiT%sz>'
    '>0hpT2^TW6cB8eChp>S4SdbgHh5lc=tYZ+;onA$MM%h@==Qi8q0|t58{1jfYe5NYmH0}gGW#DQ?bL9NkcHb4wf2<!)hH@=S+}>Xr'
    '7P5Ibo{uU>Elf^X@OiT{L_O7Th}ufF++Ui#1Gy71auD2`lU#wJNgOiEQv>~OTOT>tF`jc<PhWV~ZUfT3omFKfJrDQF`8y{V2Hv#7'
    'Iau*ilu><KCdB;u|4f=98Ozo@L{gB`8OaoENiGzY`%<4SvNrS3b*#ivbH63QkXN=o%aGRixlMugVOff8J0$B$^ab`vuW+;O>3n<P'
    'e)7HELs_I38wQx+b`@RMMU>Qtc1Y|@*<HLJNY6S!;=+0&s@d)t&mRBNa)Ta~zns1yvpnkfz|j=lKz}w**jk7c0|Ntm+_~k=BpY%^'
    'o3$r~sLaVMhy>xnY@szITQUrc^I`rpTfZ-!oIZN;435NE<DB|p?(*ZV7Z3B^kQlUE2jXhRRZVh7AT$leyV@1T^aJaVDPU;<z3#}<'
    'xEE7Hp6&)!(MZUtd!#E=dyW>&oA<1S-7-$)>VjQ}zBGb`K&uJ;DJcO1s#G;3HJ~b&nvDoaPufjP56%EK^qp=<(vH^WXp&h_Nogq|'
    'xfE|SvkQX$(A394Vo{>~_oLmN&M(sLZE1J2;PpTeb;+lS#MEdppoMB)mX`<J&avl0yf%zJsL6*mVc>z`Qmd>RF`13~#Tk_9u(QNu'
    '=u-0qkHK&dKD`(%W>Zso5I|I5-A!2#FwxKx)C!WlMVxLXD#4*jTri7;7qd_N+EO}5-@jSrq+>;*$jpO)EYuNKUKvzVf-mm|2MGy+'
    'Gt4FXHzD5#eMGH0I@&4U8Y})<H>j{gWGZ%m9_SlrCg-2C%LA*UqQFI1AW}NeqQG9KiMkHKmv)*YJL?j;n^5GzC+l@Go<qLM=s;<&'
    '@aJFwz1*x>QpDNJEDV*a(Gs~TM^i&W<ea`Q=a(hqc3N!~mscJ0Z!*pc=0BMPGa&r{Khli+MsVqphbQ)=!qGNtE_Q_eu_vvOI0_dV'
    '(}rP|fnrdq@(@cgRGVv`^Nf?fT$n1=mF0q5-}GTdzb~DZiSo_+E>n2zq*6mA^pN%=^uQRNU#-h3v<GTF%ubEVV?SAz1kMN!QANg^'
    '%7Vk$8SV2PFq|h@2JEWQA{$oV8&E<Gd?h)Er_OBeo*~yO@x-ox3o+LG=wdl3hek$!SFSEs<|rvYfZz>OdwFH%c#$q2zw<$&R5seZ'
    'Gl!&iG8PFBtSy&0M!09AQ-mj4EhO!^b7bS>V|(u7>>%lc)@iR&yHA@|7J>2Fq@6+SE@Q7cQfe*r{RrK2(Wz>}wai1#hE&w1EH=e`'
    'UuEZ(NF|vy@!}En`zYj9wVw4sNz-BG8V{*+;rgN!!8broF+!xg&(t1!*vEf2o4(Y650!1&h&P6BTMgfBM&`mvWsS$&^f6@3evvfN'
    'P8dT&8+zA7Izfm{&oiL8&}0RIF`EP|FJNWO78=}|CtabAOGs%x(3?s)wFij$b}psHdWFB_bB7QsEWa(yyV?8Y3gS$VIl|eAyht;P'
    'cAYXX8`e+bse?4C^cR>$&TNnw3#uK;A4^{4{KEB!9+SXsUdSLi_@p{Wy6Z_NFj!lIuW&rJbRMh5LQu6gR}|*mD$WMYIH{xf8Of@!'
    'i13j0426yo=37h20OjX$4CIp7e(km)Cjg~hvlP5#T}jVLdl(0xXeVvU7pl@J-q82>R)wQYN|n=enoHiQXgFDcdM#%SU*l+!PL*4I'
    'm|1m%JJ6g3bmVDRMZUn+@dyG`hEzgfyuT=3RfWGdyiIe7tT2kK5aimR&;!^YVg;HRIyafE4w^OTKDkeFJRh1PcWG#^LUEy3;`5U1'
    'oBj#5czmd6Biadl*GmGE0v0N;$*rpnQnR7q&kl}Gnu*m#TF%SXKWfR|>f`FPsJcG>TilMQ6TuLDFXKKZQ|-BA1USWtz+&<NhuG5N'
    'vDG?ZTgU)c+JXoKPNO|)P(4c32hyxLa;Ef`#`tnW&R9Ln0K4L>7MB~)kwakQMR@_yX&2{G`6ZYd4eyB0uWRZb5_jQx&D_RyXr)l6'
    'EReZsV=4kK>utV~TX#QwkAAqc;fQm<-RkdS-mREx0mYhk5JHkd5%!}-GF{X$2Sf5LtB*7AA`AG7Eq>h2At)HObv5Gno<=VPhP(qV'
    '{0=Q765K~k)CQAh+mOZ6hBGBZ?V)JeqMpfMI@*wRxI*2!q+L9GjDd$vrRS^Vd8n!CdMPqg6Rwi?>e?|xrM`kc6_4f>1)V9}0H%tS'
    'XVMT#Ye+q060wTKPQX28T{-s-^$5b3cZr<|srF4{XTD_&%?>lOEpSC`s@%3_EprX+4E<<W@tchNrFSVDm!La-Wp&MZfi4IBcjTI%'
    'F=Ba<4%bejULS_y1slYMqlU8ddkrM22skirE?3L-a=e`Htm)&uYKUIt>G{I{p#e#1KWjXL@}M$;zWe<J*8{9>(#vmUSCb>CraJnr'
    'l{hw$)D#Be<=gUIiESH!%<NziEM2duGZ4Zvb^5_D+4YPk#V|cXD^|K`aRpwTzIpoU>GNOqn~A`aqxN*QcHRFq?NPr;$MEFz+3B0p'
    '6uw3MW>23PnUQ^tP0%YbgZ0DAS(?;>RSMIhf7OAlpZCdL6Yl%#08?x`>a7JN%5!&iEf5YnmG4HelPELa=whwA3A|3$T?Bhw0ynw<'
    '^l{#s{-?H*m~d+;MTY8c#eLafKi14`YsXngv|`nZ>gelKH#KA3cJ_9fu-Z{h_8H!;XD-R-r}LO;Ha~GrJuaV*T;R{`ONoqakQj~N'
    '1N2z70S|<{cV9-bY;hAQ$rPUNAC=g$O;H>n+WzejH&v<Z-dhBhKZ+#%5ApfmipO`t*jIA;HiA0fq*A7bfa;`_g?kFZH3Dz)Ec}lh'
    '!t{+BUY|6DMq>Ribjmd_1vzbGVhIw&AIBN$F%v+c64`B|p$`+WrF>zLt=%btsj6U*Ft^(WDqih+SmANRqXUA8b!8nc!1U0Je9!jC'
    'C->1yAeS_veB2i+)=xs*OgixL20<k^%?S!khWv^|G2P6!`!VFauI(1KVKJG>L)YvG63wv@Nn>PP8Y-S#gc<YJ=8vMg`>-@OJWutz'
    'Q{e2jZ_hn#sxGuBFsepdG?|xpr>iG4xyHs6hZ6SnTQ%CImYRRXKHYzh$}Gp5^#8xazxonKw1;6GET09FQBHI6%|7@v>Z>}xxtl}N'
    'j6ZxO3{B!|!o&)&WfVLX&HN5I<8^+90Pe+QV~7*VJ3pJ0Nu6REZI~&{d)j9uU@_Q*Mb;zd#gd!<{;sG%VUKIEK_d(u-%}<-HzejL'
    '#zwP9E!qoXM<^R@3*L_Y<H6YMN`G7v5j+i+4WGvFG^&_=m`YA5MYX**gPq~S$Mv(wajno_Clg9nhXV6;z$zL<{Nwi4GcYgTst<@!'
    'I8;6P@}U>Hhki`g;^FJ1yD12Jb=D&YPrzWL#-m?OpTBuMJbnJR;ZG-bU<f}wdi?9@^C$MvH7Yh-uCUqSz<JKED)ay|I|l#mJX*cm'
    'fEe)--&luPxH^Z!$#Og#Hua~S(PT0l@izyJkp#Gn-!Er|`REJgdZXpp(j)tFD`gQL)HT&^3wUD-!}j_wIe{v9ljzGg^F1EVw%}~-'
    '@gXjk%ZoR;$=573?fbDD>b*Z)uHNnU0mUtslXf*<qMH{^@=U-+Y%MMHVeK~_O(rvnE(hC21yERwhG4^=Q7;sRc$@uUK6E$*>E1xR'
    '<!ZUS$oHfE`||U8HEMI<&TR3nJqGVJuQqcyMw|J%e^g%+dAhX8(<NEKare&sEsL>P8>vQb+%0Xg+p0@Se1k7JsAAs_Z4AcFp8_Ml'
    '++-&Aepfu8%^d}RCsYUi2Wqi&&yT)dR-MhosQPfwU3Tx?YwqZ^qr-N-g-d*bDNDGC8$M)?Fu4#IxLzth6D@67m(7-qv^Dhn>>!q0'
    'e7`?)Z69Pf20!*T?CU|2fk*`R+7>(xqVciH6f>j++NKw6cr!@px6(1W6q<=#GWvB{hs6MV)n98NPD3P4kgudm{5!l9S`j=(5-@Zm'
    'V2C6D3LT}AYTZ47AobX}4W8aVdT@-Tj%*p;^n@tURpW6G7U)K($KybWu?o?$yI_G}=u!Z{UFIJF)}r56qT}WJt7<kj^+~-c$7c%x'
    'aWVQ(8a~h5x|AI-0Tb*s>N19GW*8P}j--);O7lzEBID8*0POmI6?kq@ZGr$twSAm|t;kew*#Cvr{GzXE3*NjKzIyU+uZsVszaPIk'
    'ee_0tJb&@?i)YVX{9DU3X;wm2>r)goADarv4nz%3vD?#0O5q5vI<JRMU%xv2<-mO?L!>G2pC=|N16JgJx0ufsADq`P%xm0WVor@5'
    'xtWhvc5X2NO=^O1lE;hnyfcL|X2dQ2{p`i#Ux%mvZYERxe*RPN?WCMKOd2yc-w#s;S%fYS6pMp~`an5PDl{*f%os=``G*5f__2(G'
    'M-ez2o&1Y~3W0Juub=+%=JeHXt-}3&`uvUl`RLiJ-%|bL67(OauB8VT>T;>@$jtM_fj;?>W0{!oJXiMT$o(8R*(>(K$~a*6w%dMn'
    'fLy}Lr|TyUBv+>@qNq`(O2m>G6Oe>8AJ&Yg*7MUj5B>~69n36>PS)J25~ZUo9+hdL6y!APJ>E%pr%6x07!k0?{YA7^AG$Y2q)aMu'
    'qP)A;xh6ZCOK?~|NK4@YUB5j`N(5pUE(Juv9gIf{2--G#nObjlCM8LthISZX&I<^c&JYi(SF_8zK`Vxyjpxg%^a&;FZMwTc*ic_B'
    '?UHyAvB{b5%1N&fg)?EY0NBsG>{nNYH(8sRU-^JJ2QOZq67<X8fUDrY-xwy8|NOPQ;=dlP%}kt|ZOy-{&AC}lVBk8h?VtFrxp$v!'
    '`~rqL;|9j7e`J`4&0_R%G@FA(u8|uJ&*Txw?B)as5)B@o;SePF;ZRNuQQ6m5)w;Ym{X7FT9tilRu3N2Jb#cJAdbj@c-QlKM9iGn?'
    'U_s<)%iE?^1f_UMUlfo+&V2oGw%k;ZfdXT8WDchDvRv~_w5;jDu)z9+GJHGcoOo$3D^ljS|ID<We7VG$a)_!>c+2<}oETzS8usx}'
    'rH6RCFl8j8;NSdg6jV9osVyQ!otcB;<B=CQwuVe?rkl^jf1$-bD=nSKg41GfstgK{AhEsxYb#PZ$hl|a6&7zzl>pE-UM^P?bKusP'
    '_kzU)#~@<<m`{M;u(&GbO!y#}fLx&kDg+I?!{KxTkWpq=%q}jMD-d!Fqd<Z-?i+r}iXHpl+|2UH9j*n2Z202&>|AQ$Cr08i)4#G`'
    'jhB~K_6KXa>~Ek&_Q$f~x<NOrDh9dH7FxOfpl_@F#i2UxHxeTE)1FQD=*s;K8KK}zxd-NMhRHy0S<d}oW)4CMhE2yu1BYJ%uI1|&'
    'zrT8Xx~Ipj_}acY{r&as-;P#hpMOLFoAgNNDI;|~eX(;zlUa4Stbn4laR)Ewa}cPhp2v?~zWM#t?!B_m%dDSbU@|wv|NHmT*Kdk`'
    '4a9&bDcT>88t}#I-=AeZn8+7c(!xDKX3W*{pXH(|*9Tu3C--lcckWH5ce@YnOzy+Qd;jQYa&r54dVF%XTi!<(D2Ekg8pK6>jVLd{'
    '$2}5vKYm(VUEDr7`LMY6;r_+N$41`x7dFN<td9OMDIb_KzxaH7v3RfoBpA@Q{(AcN*FpbxP|(7H|7OY!pFV&2`x~g>pz*{o=H&{u'
    'YDdl7Cvzbqe%SmfeB4<tFF+aEFfu-TYEI4)>>`O+tjp2(gE`(dg%kg7gD_wpb{3Zxt1<j_ZeF(y@jLXtOH>?|^lNl)SF`G3gyS$b'
    '#2TJqih_5*&24Xm%dupGEMRB-d9A82?BZm(!l*4&UmLd3O%{{yHr_C8L)Xpy`##xF&Bu#(tK|p$uD00ayN@VfLrJsBPflN&g+G1%'
    '_~|LFa*~*|yu-pL@nZIFMK?iI!cmaX1T5zj7D>h6sn*Q3HeOqOa$ISiK5ePleuy8m%jwiKRK*PlsWC!&+mNLN5v?ti*U+cdZd7qg'
    '0|6}~E`Y1&tEVlxDWr-TLrge?AtC`-D+@DpUoOgv^KwOyXF`1GS<}Z5p`dGg0}_eeHP@~^2cnJEc5_;!LGkQ@cf9~hQ1QkQCrg9J'
    'T}G@oSE~>UtZYGwJAZ^4i-IHCcQLrNFlh3V;c^$8g3#K|T+3)Z9(@X0+=>k?pCg*KPOPT8Oh_6}U!0*`xiKKH7%bgPB1hv510WU4'
    '6-KY7($w3IhgtZz1JE42^O|#5b#7M)8jaU|cHwYeMruQyPr^fR@?o3QsA<4a+vl>)?9?Gtc{p8+n9Z;{9uf;Lox;@?Tpg6EAr&00'
    'SSBaN4p`p%tO)M5axxr)yT?UoM3xEROSOs%L~ek85nJCkr_miMDvM$m_=Lp~tAc4|u6;i=#zNCgRbnwLi7kFlt)(;w^1uH!+>GyY'
    'k6QWg5u*1ARj;gjxZioit<Cp7?ED3_6h6bIP-?5;pK{+Jd~c(bf4#iCL9L){YwR#9-tJNp!{H5t1C1xFUqA3DrDHV)rxi-$TC<tR'
    'A_5+V;&$Y1N<>qkeqp{T_(=yVt~Ki?5IGN8;670;nd3bIv6%#L?7F_t7~+X;rPXqYCf8|8?kt~>Dh<l`eL4OxB>myRS>xRd7rNbE'
    'EZdxPy-laG!sm}0h<t)AH0xt#6>Ii>`3aSrQ&^3juwb}C*gZ2-teNc}cRhH)k+uGL6jcCE-A$pEO697k%<wKo<W9!&ki#`C<Sj$y'
    '%*y!$5o6>tSOmf9P!L-9IKaOGjw8mn^1Q^N*|K$-xop@4hrdFf6=rA%4R+}A1vq{dS@z9rZecD#buhF;0_ldXg`#c7w_c4F6$sr@'
    'nzB0TPx>++K+7CT+qFgQHzFzllM6nrm*3O@g}74OYt#T+U-yQek1a5;y7@mFwWnaqw06~CMeO@K-Rnl}&OAu2p8fvh4%eSvPruxt'
    'mq$Kw+YpkDZ3R50%N7*erYwAs22fU;JK7~p4ajPj{46d=NO~dzCvuHy#O8H*k?Xua8?6G$rbrxKq~@K)NJ{m|K_HoFwi)k8BmqK5'
    'Iz_Fi1cuUO&4>-xEA-YhUB7z!wqvAl^Y7X6a54HgYkzugWR7yxo^L+4QJ6UUf8M^W2H*dMdeid<mfKBgG1NJafqg*5O4upxiVt8J'
    'L;gQt=RBlD?NHAr?`8;-N@UV@294>+4OsX>AFwXqCsiLq=2AITv%6%WupAZIT}wY@XFILcr&JR70-*S;7>93kQQQyKFI0RR&m3;p'
    'fHBPM?C_w567QY$|3`j;G+~i>_(m<VlQ~g4ALdeWcw<xyN8yK#EsTTY9FAE=#C|$(f@C%o^SiV#D;}!Saf>Rj^U<%Hik8htO~dH#'
    'GXnpAk;^7%v^$fsyo5h$s9Jrs;B(wapZ<oQ(lXigEdFF|qj~@4z1^2>A<n{C+ph9Oc7u`Z_R<B8vruVpcL75oQb$5yKe62zC91O`'
    'AiTz3%<LXD&yIr3pnQbok?mD&+YuxwXMouekd#ZO;7GSjCs4ncp?f1+iF$<Y%J13z%&s>N&`)H_#oY36DV3K%djPShY#sXs+G6aE'
    'ZZjQB;2-YV%A)&5eG61POr6Z7m}k{UqriA@oB$BAFMDLy^>dd38{kg&wG)YmGgaAzY{m-P_n226_{ogq6P@M4nj??_0Wr%J6jLW#'
    'Etwcp5ly9NGIpr<pjG>Qy&ehNRryM7h3F&oE@0c_>j-Ss`#zvAdX=sHTfh#t4Ty7W*!jzJ$ouBIpg+;6$&O3U3bzb9&90DRA3<bE'
    'HKJ;`4v=PLm0emm3v(GIi>}+G5k_4tyUat2czzV*5P~5%lO*AJ$jSI97IyVbO|}y(81O7Gzp4Ti(WKOW5uR}BQ!C{SH6xs^d+*Ab'
    'Nt(=7;A092EKu_t<!4DwHOPalL~Ulp9ILKGS#U?DD^8q!tb)_X>7vFJ)u@u-y=8$Xomn+>ieAo=VIGSq8ytMboT&q&=1^<nTtfxK'
    '5Goh?F47Q8nWJ|a-`fcoPRdUS81}8J#(fa7(Qwl2TPEui;s&>$>9os$P6x;Q^=Y~KP+g9cf&&!{IPY5(N9yZKSWvA9f!`E_0vYj4'
    '7uKt?4AXm1ZbIquSwjJe%hg4!Xjo7Ln={NC<$V!PbFQ^u>;!r(YP0RwvHspw_1YO6d`&I>#0^N^X3rbmbZ&P9*8y*?<XF9xA~<j}'
    '$&t^X4Y*d7(4xYPv{_i$A0MJ_x3L2zLoKP@p}#qQ-@x#K$3O0QlgQc*?KpT+8Xu}`^#Bp`P26KTZ%S~F8Lh6Ki2pY*e$(0Klr%;w'
    '+ioBl+*-a2W((ZMSkzlq9agBcieH|-89sgf<n-T%KR<nTiWVput5nk@NajiTIdW!vHv=-Vr}{WJLrN*V+AI#B${z}v_BL+R%t;tv'
    'jBMZh1EFl?_ye0SJ&khU=eo=G{Vub8Yx)Y&Bv&*6V@m3Sf14vTqWGg|+idUrc3N4jCs0)N>B;Hep8x*r8O$~KDkfe<9?(P)KvkTv'
    '4agYLJ&+becOD$k;)xe0*5q-OCi^wC$sHC)k<hc&RJ=hV0p&uh?9^46Z^PyHByNN<1OTRcGq$^ZE7M8Qm{+{5ceA44t=L{s6F}(X'
    'P@tK|JTrfOuRW6ni6cPTWIal6nh2Cdzec|4O!G{GrdTy7D-QT-R-2Vw1H!WL`De27kZnZ~E%XmHb2Vk(ocZir`{kH@#V<6WyIPE`'
    'AJDa7^$)(J^qY9Rs7Qttq6A^U*!cEur#2VU3TexE48VZQ7Knt8uLEJ!cLw2aLZJX|l!U#`TMBEr^DObwqcgFaMImn7H###^s*%X1'
    '*V1BGWEe%&+JOzb!=Iit6ra>f9eg9b6Zb;AOVxL*zWZ!W4SwqpI(qAp!1>vAJaO!+Ep)LNC0sApYmm`&7Do`>ASW_Iq_B+wv-9~D'
    '95ryA7B0viNxGDTYCwOE!LT&lhp1IfOdQLxSoSas&x;QPcOgG+Ri3zi4$9!3E5RWVqT$&7I=0>?%FXLI7lBN&PyfT~p^=$(_VP0g'
    'z}5(-K2jeB!ez1|+D}1MN!?=MzS7R=l=QpGb{Q#g)VHtbI#!tI;Z8%a3xF&(2n%!#r~w)3=?w;R^lD<E(?WwLz{v75NPGw4Q&85='
    '73~VAhIba!jM>8ZO;FE3j=bTw4Bxw)FW=dd@sH(sVZSp!Jf$J_&pb5qLx9Vw@9uH&XO0An(}4_rXtb#0`D}%@v0XG6?ZKDZC)f5%'
    '(lppHK#!RpDX3O<pTI21#cOaAnQ$N*`n;bt=+~pk=#mmvdC5|LH+Lcgr8FuV%VCy!u7q2REJMu&>;T9-e`O?=6`%yn=K=~(ph`i)'
    'R0xhSYq1^<%`H2h`nh5hhLYB6d+7i!%hdtodge;JR5Plask;N7KU+y_@Xg2EH%X-{enOf>@DARl)og`5G+YzNOo1i~U%}ZM&E~*V'
    '^;Nn@#iQ^DLk%n&{&_6?)*b7VR@|yhTM0d=@-mVogr(-?6K}lD%B<e`a&py&zB;b+b{Fs_F!wgU`5qh;K#FD8(I}%w%GnRAmm#<8'
    '@LGBWl)n^iL(_a^u06?FB*Tb!dD>Aprf4*FAa)eC_w*lcURLFz{Dc#eOc3gp+%6Giyg|wrClJ2fEq>&W&;)A;Y;+-(pU3k}1!Lx+'
    'lergKY1D>N+f)vHYGO!j;53lGVdU#)x7<#CgmL=z^?DBJXzq6@b+6#mK!`@(ueou(R~ys$m34q8vo!IBJvHCgX;D;X!6u%n_;TIU'
    '>6!?U%+`Ypi&=5Qo6<UFpr`#MOec#zy4zJ^D}_h?WWG3+l=r<<okTuj40TRIuXiT-&($B=?>(JE_Lv&par@>Ke1#v1yLSPz!JmZG'
    'Xz29hPpFI`e@OfGu%^%GU&3HHnI7y{ba4NrN94xGBfL{2iPlaVI`6rrx4Cuv^7cMa8r}qyEj+s4_Sp0>iMj%*daqL<J5ybrGfLPB'
    '8{C33_=Gsou{(Do%9~OE`b~uzE<S|yf!iGUv9(8uyCByiZ=2>)KiqJm%2j?dLL2Q-pRcJw+Q;3Agvf5ZRZ0KdEZCMtDa;+L4+YcH'
    'De+Pjj>c;rf-}W+whGBw`8^x}bNZM_$_c@rp)WE(&<dT3U}z61LZ_A;&G;~jo}k`&Kz-n#Ym=Xl_fQ~usL$C6D6T-fgTfEAPeC(Z'
    'ujC4adS!kazQ5X*^sW}$1&=l!YXN4m;^kVd>NQ4$2MurmtqkSPM>QrqDda)i@5OkuT2L@~&}R$QoZKEd^daZx;cW{7qt5RO?InTp'
    'uRhqiu;JRNZ%6Aj8Z?HX_A0w8YbujvGQx@YB-wCCBasY;kh{Pf_~G!Z@!N~vpTBwZ)3ejz-(EcX{kPNM>o<?yoW2fn1(UaqbW)b('
    'ZyqGMul}U|IMVQGWMoQ}>!O}6@a}ROVq*F~pE;uN$q3D5Ow50@1$zm%Si4vDrc;(M$sfrKbm>D92?rEt<9ABk)i9=NUY3^!g1)z3'
    'tfCwpJjXH}no5&G)(E5TR-+4xLhGq1ULaiCds8#%yFq0^a1)}Ir(;-=QO)p$54D;KRE!jdAUZ8iRS}wwxC@~sRIyaP^0HMVGq2k?'
    'lQ|_OmJm}ydFY&<+~G({&o+QI*r+~H17&Om7DXnwPJQ!)t5xg@*IP8itfoq+efP7Y;vA@NI$%7)H0IG{gr@g&>&^-v4E<uZm|Y-l'
    'o3FEu)zp80A>rEVL+B5<n|jKAtj3$)lRm9$G#Va~NQ*;oTM(q#T2?K_{b)I>W{Y4rR(%eaGDlMU4*FcWgX_>ZTwh!s=0gh_Kdf|a'
    'G+RsO;sYcb23WLycX<y{-)!hDqK~`yRrG{FWI6l!Ar@(TCKm@Ios^@Co{eSZP-c4Ed`SQ8Oy`^G{Xz2~qQ+e<#s~7;?83zo?SHI3'
    '1^~<hg>Y}){9}3Er?}kNq)+g0mw*n}LUn66CoqeLz~@5Hq*)G%6$il+q*!){ZWfIeIz&sV@Ux=_gBGZE)74#7habw-qMRR^b)GCQ'
    '4xuRCz+UwZFpA}=QDunR+QYQ#_X%auIewfqet!1%;ct%~|Mltf)8W%6jX}R3U*)bUM2VkOXj(d83slnvVXD5vn?tiFmJNm8((mU>'
    'xn^=@4m)6EZ-QeTCaiu-Sr>3iK%lcZ$Kbp2T2Psh;#~Iq&GYb*A!MSR*g`L;;gXy%nx-H+J1`-3l!++}gh@jezz5>Xhn||!4+D!g'
    'ZwSlFM{oYxXf^)&;x{9VHGX;e=C8m1G<@^o*VE_bXNWiw0gkl7^=Vo_Y1iVln>$dQg5{iX?_ptrz<cx7^e_#1-S2;7)N4w+k_^=1'
    '*@dzHsQ`-s+{D&{Y_@n`!n92=><KWHfT_pa%f-kVD^wg;%kZ`z&5bl#z557Aa4Z+gAR3RKz4-mfPp8ix|8=M*4`+u4Xp4H2OUn<V'
    't*v6vkM11&#;Z$Dm%3n51ge32NQYS<BiX-eSbAlCV5hJM+%Ry|yo=2FHDNjjpX{T{!YXz|4BU~hmiG-HgSuZi&x>YDAH$aI+n^=h'
    'J?vp*df#G?BKTAJD>;=vdYZt%wm8Z(+GF#tYBYtrUoIHk4Ro0CI%e2_k8K3Vg41;R$dIa*bvx3oMs~{jtYnC05*J||O#VYYLD2iY'
    '=VAt>O|Sbm?mN~1erI_;>ASw>lJK1(Tp_C@eGQH_xxIM!B>w5H=>WD1Cy4<N!5{GPi|0Q-{l)yp2x0xkQKO|E{(AcNVYeSlgID5j'
    'kDmR03S|N+e}fGh`Sk>wmhm#i@0)JdCidq^x0Uyn+u|%2`~3Z2J^sMq4_f;l@5mqDywFDFD{4q+uyW)_)M01Q1c{<fE8ot*rL(s0'
    '`3gsq2`+}Y1o6M-Umf#L?*MIOld{Q}Q@E+X`=UC0KdZ3Mlp%56*rjdga=*q=@`u1pQfhQglBz->Tymtb@_yP)(NQ+TaI6D9!}-}{'
    '-E1N+8>p18q2N*(UrhSqd)fFQSl_g#Uh{{>Lj~PPo+~OuSIJ9-JG|Z}5}TGOYsCNm^+jFgFaQ4LuP>e(?&$f`pN+8c`s^=8guMkJ'
    'F4N1Z<_aQm(`c6)L&?oZ{fh*ca!^VTzCAAsRM<aTB|{BYX`dOGMsm6NqbJjx{vD<f__3WQkUGA{G}@77CsTH~tGaLgg<RxIh&cw2'
    'zxQBPT7kqaUPctZgs7IqazR=jRxgo)uTwlSO!(#d@}gV;{-mi6fT+zrFFq|d^GPw8Rc7erXeI6`5_8%jSqLz^!KgrSSF;KZ)%k2<'
    '=D9=cy<CZE;$EHp^!w9iPliuUU%u`)x{a24XEDJ3K78@F(^t<P{XHxJ%>7?apS?VN)!%J1WSLFp4_nJ{?tS5UeztJgni&jun*G_s'
    'qx-}kiq?$;Yw{rN*Ex^2D5TtJ6k3j2^+EHc!fxwC+g21mY&PIochE}23d5VDLCg0W%!;pvShJBOH}kSO)Oe3DiEYo>E+w_MLbt+v'
    'OAa^j<4qb$B}59?NKcfl%Z-$k5wBaQAn1#Ws`K{k1M8uD_4@p)<@@PHnwS<SV$46Vf1=$CyA=r0RJN#DYPbKIBm%ey0%aKP$zJqC'
    'fxi7)?bfrLL*}4wDVo_!55w}Qt3iEn1lI&=zkE=5smAm^W&ZYXx)Yz@{Aj7QI%;7Pee``KT<?w`T;FUNfs!>EjSfdh95h(Zh)VOz'
    ')d8zJn*bT$3ZYg<ilFis3uyE^z+hfo4adt1bNLDQoTY8P`QRsTZ7fPdGXP?0j=2AYq{VqyjEcGWQ5G+8;XuiVdX0+p6qj&~O(0tg'
    'eD|^RYzJ%j5<GKk{FLhh#7_Zd#*n}C0eU(V2f{(z#sH5oK}X?c6&>xedRR;Xs(?miGbJ7!4}-IQC>l-kX{>mC2)ePux3_Gc-rh2g'
    'I_u?T{9ekPXtfx*13hGH^|!a&jn;m0`s}H>>;B&BzP;59(G(iVg4&&bIh|G|xhsO*=AaAMBMVfqnT0;?n%*k&!8vBjz&w*@^kt7L'
    '_<;%!bPhVqP$I9PR{UIt3L$};q^u8AG+|EReTKlWzK&h5*JWnCXqPm3X&OoIi-sseLEQ;^UZrlqXVujOBp>0&mnx4-HT$O#Aq0<~'
    '#*U3;+nV-~vAAr#y)`;FEBLUOlJYZFd)h(pw9zQ=3sJNeR?|LpN_Hqfxd`$@uG?5Py}*K+gngzKBzul{rNHldTeVyrL^kV%6|2ct'
    'uWTcuwW-tCxHHbkobl<#`8M+Ga$*+H9_<~bQjS<SpV_&Dnb|gxwo*l&&ArWucFR=?+0{<<veLFFG*j_B!<4Ig|0V9%v$wY-5yGvO'
    'M-2%dHQr@rpabAiXN#2TqmcrZ-d|BdSL1L|ei~LK<_lnpLTcahrdN2p*4%X2G5<~(n%>?b)6m;nC`@9x<`3p6&;YZLDYKJ#Y_7kA'
    ';VIRp*cc^EX01_Svto{FHe=(y*$;tRL+C)UhXcR8_yD;+XO$ENq3t_j5zFK5Atn~B!Umz6D=B6!(k=>?Q%*1*E{r7a6Jnz}q(RR;'
    '!g|x-)#terr5#cOpjF&eJc7O*r-){En^E$%@dq-h04F#c+n^~<(<X1}co39^tT_~u35*A2K3yz78A<1zmuT-##p!3WE61}nti*>N'
    'O8SppJ|*sKwg#&zSee#U@n4(S_{03_Ar^rU7(-Ao^@)SrBR4}dR#NpselVA|qDH&$Xg8eloKvN@5;2jLt_>2aQ@=7^SP)f1IThWE'
    'PyARXh1Q&0(Pkn5iV<JH{#+9T<@M#|(<gzSFv%*C-F&MvLE_NjL~D`9!a<#v`u0}$NBYWEUCD7|OrtL~fdi3J^JZwAdwUC1KTn_k'
    'qHfcDe8G~=q+hewcG__`XM;LopqwmgHysJB<OvDB(SAe(DGmj2CQm;+=QaKa+=zH?LqrB@-rLOdQE>m)MK>qHLUbG;Wp6yUW95`_'
    'V$Jqq-}(IFfoL?7-gQ_>(x>kDMm}|J0a6Zik~$pCF$dArr0>sw8U`L~!dRKDImZimxL#_xvsWZh>Jv_A0$&a}2h3DE@1Pa<ejYTw'
    'N7^zi*xQ89*mVtBzUzhunePzpNNvD*$*Mm6j6&aet|TWy2;hw_;k<R&DV%i5{9`m-mn;7JohoEq)A{!$1W}IILM;n18m~7fdH4(F'
    'gY|p&0G02HQ)`GB9wPJuhIzj@8>Fxbs4@tbokLupAM-=S41Y7JKns1)I28Xg%54`MNS*M&@4d~U5e5M*)(JRo?>N%VBiEfUgJRR|'
    'ksuNfID^dsuD=CP5<>&aMlxk6CU*xVHv<>ta6+YaOq<4->`{OrXI{WN1*UvHV*qn;J>p&7hDeQcen9LM%TiPilG`JTO=#0{I?y@_'
    'S;}P*#VB2#WLxQ3cVO;2$`TQY`tSwB98a!>=in)WDAhACh3GWiUXSS$jR9pdN&t^QuLUiiV(MVx<w*vEi9Vw}<UZoxHh7%dHX_ib'
    'ask?zDv!He2om?dF_-df%m^%VYUahxYXS)?2o>{lUmyW9|Fv8(atL3pYa$R~Z1xc3_PXmHI>Ss{4{||>q?#?#bz4<;8_RJcW=Vus'
    '87``DVSti!z^1mCkhEHrl;oW{(w9G4(zaC(7os2T^H%U$X(~$9fx7_^H~RC@#rb3e4||kefh)7raEE*jLN`_P(L<0?W_ay&A4*Ko'
    '#E;1i@-n1Cd+mn=@Ta>68w{Vwpb>q*3shcB!1E1m4XMbFq+6_qHmVP5;wUVElFo%<`7D%|qQYeraXoe?t2Tp15_S!~2NFTw-#paU'
    '1$X_|CXrsoiN8eMWI|-C$&74`c1%S)N~J2^(Y6CW4rmQjjF9U_pEgxf4S<hhzG=O#{lW#)#_a^##}Fvmw7NNpL$=`Shg2eJn75Ji'
    'Ty6hg*Zu&jH|%!pKN@^5+D_la8Ftk9kdfs^oEx7zClumf)0I-D_UNQ!cREKwrgC1p6Ys*PnH<v_*9i%Db;n(y>Bx@NW<@3R7|tVg'
    'u3QQ7E<n}{XiY$K_B_C*xe&b*xCm|od5B|$Z%k=p$$fkE!FDCZLx@Ia$kBQI!pCJNM%W>NHy?(dSZr{u+Dk&fLO{>DTwwTJrn#W*'
    'X5GhZqQ-{tzN#tGD#n+as(%NgX^cEEyg2XQKYDQ73>U0LQ`VPB3uc|3YTC$BIJDM}J7C(~tl&}}3IM-MXaL$=eVARc{wl?W;bKbT'
    'jyk51q4CfMuXe0XmKnj(5~Hz9ilg$y<43PU^<Rq46G*q2+}!L1YadTtW@x)j9<^LMb$DZMpSQRsJ!{b@6kqoNOwKz_7moDXkq?#g'
    'OXJ<FmzUqXjpe1+ge3j?HqC6yET)abpUd$#9vrIWQk0lh3kfm(H1q0yN$*J5!v^3vcCZOx8pjb1j9gJOb5CB4=O_luAc2w*b}u0z'
    'c67AlIO}`2&)didgaHSOZRZ}hkM#4PYgp;>GVw7T4DXR0x?j4L7$9=Z(Wv|iyyGjfrf6YY+6e)|=e#y99eKt|VOvwf4_VMqLz*BA'
    'N>WT#bS8RH0-t<Gs!CQqY9*`H0@!b3Ck3m4xPc+-W(KuLf9&sJ_$6HcmHTmQB#OpWC4ffwq_&EK$Zm(x<^MEdH@0fM0IKE=GR!th'
    'Sw^Ff6i1TAv!J9~?4$uL(OfuN+{wd7kAF>F5NryPGwV%%M53^4b~<9?foDy-*>*vKsjO~;n%PE*$bI~}gBRD5I(2LS0Q^JQl2*Y_'
    's}SOATEv$jXu;)L(e3PZ#eh(ixnZ)_o`eqK&jDq1L_b`5-D#*u{RaAE`5wpts5Ori%Ach~tgeTFI(0km3n4i}O6f{w8$<>iPDd12'
    'W$~$q9UgL$YEN^XLPtOuL*<XuEpgARJqk6|Y%_|I^V0L!eGW|4&(R|gvu78OH^OkitJUU`fT>4|%8UW1w6kw0DU<89v9Y+eJOM5X'
    '1ozQJSc#JoxP0=<Lz~l5^0x~m_oiofIa}DYBABH(^SullS5!o%gfD4erKR$e49r|9lg+qXrDLa4`<L8YYSP#xQ+hYg8uQs=^Lc1b'
    ';ov~Elx_+lO^3=z6a{aOFW89YduEyYkiBIC0+wt=%tUIwy*=0}JSX-9Vnnjq_vQSuT<Pv_PxOaV<&Py<w~a5El~q5^kuC=m4Q_l~'
    '(%X@?g6u~6<rF6VNzUj^{6d+!rFE;}jsy6ew?VLzU!A`G{n;C5&QqtPRs7dxG{^K_eTJTbKxT8h7(QvSwog-Yh#6!ymqX#crGm7('
    'G|x>xc__V+iZ9CL%tOzz+7b6?w7LlO*g~9#iQ<?mo;rOHVEv)<2-KDYiKzo{V}X1pT&ygHP)c>m74L|Rm0{JqO7_Le%2s3%t{@yQ'
    'm~p}CX(F6GPPSa1HpO^W<Bg_vrv{@ooh~8Lf_l9YydTihf;4t%T1aR^cknpLBapc?;GlR9%#J%DD|v%#xt_M%a05+F0x9n#O!Wa`'
    'W?o_GwORM2Rv-FR1gmTd#+qrrE8q3~5hoUeKG@9{D7!Md0;p=`n%C1<wU%3tNVArZlXlw+K?l@cpf@+#3UmdWNo7Mx--wIq!>H!M'
    'ZG^Jhu$!oQ2^0()v6qOhfud@>M=rXCd+!rgvyBvIEM}shCz$C9LLO`o7tsNTg?se!sUVMlzg2>~;@9S-S32ubK$nq+GXD6{%QwHj'
    'Iz4OrJO^IP+nMNI(V`w&W&$ocoBBKn0$!W@iMpVs<zWA6;e>gh+q@`2P9`WuaIv8lf#XWQ<z=_4ktJna^!%QfyybFD_~{G>HA%3-'
    'Dp}@Ud^DGf5w{HC&$Xc=1C#2E(3gc8IMm6$GnXUr1gbv(4$ny{8itK;^a^w4!L^R^je_(GLc(=spvdtou5^`{^uvP+1NGYs;L|B*'
    '>3TE+(`%z;WfXb^d?v($VljwDtQyUn@<<PXZ5J|%%jJAFz5@ICV%fNkN{=?{<!}O+{L3rmJxFAxXszUYOMaM5wKjXVfbKgBs~uf<'
    'iJ6(3nX8V({eB@^kr<3YBB{9;M$z%blJS%&-m99@Y?4B@q3Azm9$L`7>C_F3@y^K-GlYuz`ZW-Xgahk!bPsfLoIb{A%qL_GIvq3Z'
    'J}pQxE;c2>o}?&|vmj<-^!obg1yYE_%A9j!^wYp*lQ=#CAxcg_{*}`bYcGwue<u5YMmvxVVcyUmDo1tIcg7gYlaNWcf84!uzqvbl'
    'u`q|*6T##BCWH|`<G3<c(6;B#f}P-t<TP{<$>~>kowMK=qss4Vzt`UcruY5L?R$k_+?*BGJn+|=<Rj9_D8qdhIFo}-4v~qS0gRZ-'
    'g8LF#hGY8(=K#msq*V+}>-)jnD$d*WCI#jm<yZ{%o^(QXpZt#5$*+|`M*_@x6CqTMo3!V9k6S_!a$#<XN{)|Cw#?o;t=Ub5EBs-y'
    'JFENct@*FoKHo^}{+Ef+yO0hy1$$5n8o}NK109q0qZ9vAOKlDDbrk*voI+wZE1Q4O_ZoKE#CktbRfBRB_49UptcGWg+W#?X|5I{)'
    'sjr&W^)7Na0BFxJBktImvdE00r(SJ`e##xG#W+h8O5RW1*A|iXFAadx0Jxhin_Ug1?@fkiI)<ZlKbLrIOWhGRPfd<Hvkha!p85oK'
    'TUw7`aeRuyV~UY(!ow>8SedjZ$AM9rf&+mH{LgXFV13S;-86PgIWNcSwp1ntxY5VaYz|SkLwRGkaNDB4|1-uOPgXN0<3om%u8*F!'
    'XNheuXnIYAP}juW<;dX;<;4VDOkwo@v4UG9Az8u_$wxfwZ!aDNEDg3JEDipsFOU8P?b+g^xw*iM&R>3$-m8}XRJ?SVV~Xh#^3hc`'
    '-Ar(iJ_L)u#Fj~!@n`|to6Lt|?oSMeP38jBCj+u8<K@EAs%2-Gq-@(;ZODZs_{lpUOBdB9>w9SP>V;FS(krJP09!fY>A6PnCv=D-'
    'CX*&lEu}WIeWNhTWCdzxH6;c!Sx|A+&ALgTIL%}gzF3p5#qQg5HOb9wIxm|e{Z(=Y$!6Y)7-l#8BaYMN5C;ftxj3J_+blO#;me(b'
    'euW0`3MUp~C&ZR%81nb)s*~Hbc^I*HqgUm6Qcg$a&x6=nBWg|cmCLmi=h+ggPsod8Jq7ef97c<!{gB+q#L&zhbPtq`s}3Ba@L3dz'
    '%pM#QRt*K7QVO)dZ500by`~E4{MWNUA(NG2v3wY{R{-C;gj6gXO;|xzh2n*1W_e?+46%UpBFHOG%JVg)UZL%Dv7F$-dLU{ybmy{O'
    '9u(rLU>&^J9$b$ocR6{3FhB2#SaRDy)+Nx4g{6Hb5&8u8Yg{t$5>aJavT4K##U(PcqaccKZpU*b4qWWI=;v#p5}IxgRH417dUEiV'
    'wtMy;OYdbkv&AKv7tA1I7qe(U^vaKTXNQ>D#PeCFw4m#*MJiG^g;GLatln5dM1Iwdd@H`Le)4X5rppoOV25=95!9PmIVf@%Z!^=R'
    '=PKr+v2WxrmT5wJjIq0L<Te(3inoA#FMfiU#3#zDoh=0jGnpRgvYcpJJMYSCF5j>hCgVMckC<btlC-q%sA?>@Mx-=NcoQOQg5+wz'
    'hxz=#OJF3>4`QBd@lSK4WI#4s2dRaCOxv;Q0Nj{H#@pTf_71<|CNWK(n;ALz^x+{{55#9rX*Wbdk&Dd8D9+l9)ZDw`n$3Dz=&EUY'
    'VIS(;BQxb!N+&a{0mMrCy*x%DrtvG;G;CNGCtNj)cJam2$snkw)5$cH$jYyk8fA~<Q`cc!x(jrXZK6d+c;*eu5_qw)_X-d*!SJm!'
    'FS_U%ZxsHbCv-}>DFXB6FEh2r>K=+2_Mehpg8M3^^uduw&%M-vu4^hmoLR?Q=VA?zN73Wg-tcX{HntQf4+m*bOq2u)kh&SE1m=H>'
    'U*c!}t(i1hMJC2vEMx5c5&59(=v&f?9X*IJghcq;L>SvGsVOKaN^7DpDfmC3PYnXd>ZZ$1cn~cb*AnG%<)Y$K(eG>3dIOnl(jPM_'
    'zV8(y=BIdDh=Jtc4k%b6)+Q^Gmv)QYI8^%&4b!F&ViyIx!_>Rdso4*f*cIL*4w`1wa3ITR`o7gJ;uIChdguI`NV5I0pOt#UQ|%^0'
    '-#Y^p`xNQ$QR!jhxySDf@mkK8?`&8~t*$ZJOjhTC#4M{s46wN(`Mi}|SMP<=iMI+((i0lgRz{f<#0pqlmPfSvtcN7!6US~k1TZxt'
    'R=pG$#91?7OFHEM3RPAJwih=m+nnIPgzOfYb9EOJc&x1q3Be$pH62U{LV~iDi^1}<X!(-=W4Q|oz}tka(4MYJhuvbCYy`wZQx|Yw'
    '8*>w{z|$R*wh7v&=@S!Stf}%;0rG8sM-xRL{gIW83>6$4VLQ>6%4N3>*(S#t7s)tkC%I_}7j6_#)k|e|+cgFco$Dq)3qAE=aU|$W'
    'tydg*#=J*uBDDgOjiIE7l_1k?^Q0A$D6Me0hiq)+QP)FkRl7wqNDhyOGU-~cLAr;m<K5IT_Ca=rTt6|B8N6u!*Jf5i8NFdKeN*xM'
    ')88Kbayoqa{N?X&UIWp0Sw-wPtWDW&*`eTQqU>NFH~lma=$7c>V8XP&L2Xe&Ca*GX5vz2g;0d9W#CC>Bq^2VpB=F7Ue+dxi9r`@i'
    '4fx$}7dxg4dVA}C9hvjxl}~02qJq2S3^LU<tQJ;k0K?_B^g#vZ4|3Scjo=WAUPkSn^oBm}M%kNm0J`p&1;XL|>vejwuqI8L$DKEn'
    'A3%nwD<mi|+Ar*`m)|F)Avo)*gXM<r%g+Z#Cryup_tkMpYa|l4l+#h*?#GLv>Dzo_m4zNZB*aN6C%iIgUja)iJ)4CkpkfnJFR6Q}'
    'x`=P;Ya1W99ay4D7rDLF`-&LTLxFzqeI?xYp0~sn_W)0n>8CyHTZM8T*wJG?Ir7LC0T(j9!JEk|oJuENB-`TL-+h~o96G+8P)Vlo'
    'x@q$PMh~(HNV8<GRb*3AnVZ2-kh%<!`Ez$>B-U#ejT)2*(U`-`+d**^{+fv*XQiBF?UWIN3xgf*)rNALQ8eI~v(jvk%{F73&cVPY'
    'fhLz=rLG`5S}`g%6(XLC%HHE3xr@R*f_!3wSIp26a^|Y)KtOa8bgCp5@RKu&`L}v;H8aRw09R(p;oqG{oId9zzBy3He|?W<?F@&L'
    '<=C_PNe*Y)CC=JlmY-}0mQ1%X@x7phz&2^iS>Wgk+VgF@=TT}Vje3ky3q9?OCPwPv&L05NVJ=h5D2<Bh{!2EuQCvZY8I`HSUR=}0'
    '-ru_2rh1@*l~(U6@(hHp@jvi=Wf$`7xTifpmQ`nSF{(ZsbeG+G_nLJ<yS{J%m3EYbfxlVIz`s3N!+WyD)`(?O0tvoIN+r}8fro$}'
    'j;o6z_i9bvq~QSTZ-_@JoG#fdNe7zDe1#CweVA`b0g?v!Rt5@c4=!^x4&UUApRjY-UZ=}HPnk{SSg0+VI`cgrp{<{1H>cS9QkxMd'
    'lS0losAlgLn~PR4oUY7#>tjo(=ucf)i;eDd5~?Pxp{Gib#K51UdFS=hU*4R)`mI&C-%p>v(LewC`%B$Azo7rvUaIzzL7Reff-7(J'
    '26`Xt=dzLByLtw`X8-zoH@R;kKw@8M(WUFg+%D1{ULwOGTt360+#<A;udk|gd2#xAM!G(<Gu~?5s`WX%)w}hl?+!QB>hOHFfEd9-'
    'asVwzbMP8Jp<JTnCzM^;%04N6o?nSmpY;|*CB^@K{o;9n+1@6zg;hbkUEs^%aJn&rgRyW{33T%!eFct|p2B?CA7*~t%^Ukj9;}Q='
    'x0(e0k%5B+Lc?Hc6W%#y2v46hssaQ%bNwGq#i;plHbEpB&?K2dE2<O*X?OvO<I$ohFD}<tph{T)?||9$-Y@6yrQuc0G-0YYj&@bE'
    'MqOpr;<4dn=Y}cA8kW_J(Z_KxzGjC5Y9(>rc?t0A$N_<TCf-6?-Gj3Y9z!6~$z02CW?Sgts+6%YPK9#QmYD_6Gvu@(qBAVB{De6Y'
    'n;sYweHfD*oruBi8>k-GWrzJ9cSSo%qr*5frv1fNvBP-iFB|yE#yy%X2o=}u5!=TQoC+HSm&g$5kk^lpsGL81U%Pn^toDKSMPE`0'
    'un-1$=c+y!L7NeLHa8sOi+q80S^~k|lF&A^fHuTX+JLGX*9@rL`A}X}Q4n^`O8Lj4xR_NH>|VLS3_UF8lPbW}T*EYx0R9PWrp?ZL'
    '`N`bAVKlJxT#z=@9AfOSa(N#3!Te@hT7&(U1}98uHIQDzRKOOR(=+<p{CSP7+s~+@d(4HLPD2pl3@xTpl;?*)#9-0~b^xFf0#-db'
    'NN2K61Ki^=>zDaTE%m^jj#NRx=f^@fUw23bA!h|fSp`FHsD0dEaJF6)1ncHU7mubXF7ac(n}VUvcV8|l^R@IlbYs^i54g5e$NW7v'
    'pX)uxSAp4Je51$-q(2Qk+2Hnra3FZJ)9w>EJ8J*Ce%H>2?33^MjfQ=ww}E-l?RJma`2RQEZV&(eAC3Jcj>nQ(e|uwLwl{Z^VO(w;'
    'hGyPrk3Ydg@+Z;8syD1VpZgOY!<Bbs{_E6=Uwev!kx}5hjK|y8z>RVT`*M?Z;GUgT%PFK<U&n{hW#0V{)9W8_4Ls*RW>#I-kW>9U'
    '?$vZz1!X`VOqVY%-L|Hy-&ElfBkoma{m<EAy41+{^5&`>t$u{0uXaD#)0QMeezew^xpPPD>7(|~gD)p{t{W|Ho7(GlkCoA}CuUEj'
    '4zArAl0(BZ+Vqq%`dByreAL@cBpixVxCwaA+D3cKs4EOH(Np$S7D`(l)WML8V+gk{Y1}IkHkPZZe_%F9tI=yTTO){;Ff9L~uU)kH'
    'no|`6=XI0%zU$k5YR1C#^Qbr2k#p0Wt;aCi*$coc^<+4vo@5ip(c74k9`c4~z+aj@)c!LVE_wm;1h}9v_O-7Sb8Otgg|2u91o#sx'
    '8v)1h_7+{1knYpe0Iap+TYy@<y~QWz?X8x1E&cI-@k^vzZ*M8E6x0vKZ93wi+ZBw6FYpWMOOf`ddK5W>A(?Z)6?Z{T*$q16m&RPA'
    'R3hY9qogwOX>a#Yf#w5ZYrP~$VzD=s=)H1Ay%``==$4*y1(JlRRkN^H%=mkrs3Te+t)c0EGu04q-vA%e_k9t;cevkh5~yJp*Y9T)'
    '3kpiac*xQnO;$xDcD<T8?h14V{j5p|2n6a5UF*F%B_*jI`U!#BV*4JjYGbxAR3xZ7zQhh3iD<nsydD14lnX7TIK+I>pU2JCPI|!O'
    'P<NwgAr592a+uc^`ctH1MpF|4>my>DOaPVx1;`V$GSgHPZZ0y_OEo+xIbyhze(3EjQ4qbowXcRqT-LWLhW^Ic%L;SuX^Km;tqDNL'
    'rH-A>%aXFW%hpCGm(prks++2Z+(F)==kODc2kIsKmQ$I^r=XFw#a6Bcbeah@Qs_3r{wG6Bn`dZ*!y)FNg11HjTdu&#u+I19tzHRY'
    'McNm$cch6lYhvi7Sum^e*}X2wYUQ*=RM{EbO8CeSR?|y=-|gN)tXZV`St%9N3(L({|9Cz!BYBP6jyMZPL3{<?BePCdZ~)0YN}Q6|'
    '-XZ!iwVmiLV7&xbjVCk8@Oi#m&LK7Mc{%S9@_@N1lw!y-dGbZb2kGu&HJtnM*VDhhhTNXgZAOhS_q9ARJgWMokciY%XP;LOm4Q7`'
    '6wbbSZ0-2!*{Xc!cSZZ1tH+AGtEZulgL)M^H|U-?Ur60X=p-1w^M_!#nrEkvUY`zMzIyTI#p4&xihi*FXg5&WwvXVE!yoXH;D7!b'
    'm?ta(SsK>M@p8_b8Vc!V5a@hD&qBWeWUU;7K^{H_AeER6b%p7m%q{{hwdZ@eD3p9C-71#n|A51AIhw7i;rr$CL!XI*IgXpf?7ueU'
    'kct4W<AV5L6DwT~rzu6XYYVpmhf~P6!KbKcak+xk=JYd9lbv3@9-wCKs8t;M?YQs#hCpRWMtZo54shnpiAvOqSy_;Mb8F?dLApfS'
    'M7Ek^FHDvCAtl2F#}EA71Z}eIhaz`f>1JGUxCm$Q1{x5eNdg%-gg9Bfy~Sel;LGjfYuJ0)N<Hmo!YFJ9Azv2!r6(>kz3kg|;+;OI'
    '9keqs<K{~b5_W-gtwHQXL&1MJeg5Y4@bvlLhCiL$p=0*bqsPCVK7ZmKUZ?8=Es^R2k*yqVjGok!J2<KIL5+(Ih=^2(1YzoW2PcU_'
    'zU=fy;U>0tbQolgk?s$OIZLO*rRlIcA3w0d#(G_@7L~hN64ytsh_{k1tck5x_J^Qgf;iWf_iiRCsVp!-VMW%lsQEptDIQ-2yL=^A'
    '9d*VOGV>8mhkyHFN!tCrVCQ(<(RU;Dq^j#kd~5ov6t|GNO!MDddqHz8*(k7qWzR^+VuC;hdghR-QDj?8#-h{4O$p&b>rM@&nyOv?'
    '#T53ZAUHpv|5(WK@R5o+fw#9HPZ@vX9h5<EEVwJ;i0-jcJNE_^6M#f6FA}F{;450}P3AUtss{Z!aW=$f!AN7HYJ0yO7jPCZXM-FU'
    'po)OD$m@d&^P`fC_JR>Eac@#?bk47nJO=4f0bUBZs-E|)7WbI}3dH?F%lps+B&$8-a(*b#wHlOol9bE!13mCD;c<^ysFu|Oqm&Ry'
    '42su_C)&5VRjq>T=ZUKflWxV<bMuk*F*T>=3$}ml5KzJiX0vd8?mey7!(dY$<G>#YD9*V)$(63VAPRD^{=((CxkR*|QeA?$Xk3k_'
    '?WG_Qz2q%7E_v{M5XRJl?HLMdE`Wqq&_Tb@Kn2kVm5s?`+j6&~?Yae!qDs}e?oxf~@VDHNwT&eYD;47Ei5fK{D)(u$x}dFXJ^YHW'
    'c5f)di{*x52>b@fnVMCylIYnC3rk1rOmcsF4e&<yNgcYz>Qc0&0#$XUM)aT$I8BbD^$LktgY=T;tcI5ER2k?z?DQXk_!i#R(d<JF'
    '+vzYbQoPEUYtHYj|Fy?}d6jr?1}Szh%$t(yx!)pMNbS6ER3~l601e%~tF2EMHm~#YP@m7jmJAa1`1J*wnh6C1Mq@;+jUX^p^Yfti'
    'Ub3dtA?-(4)JmX?#m}_Fv$ak#5{Pu@&0Q>yrldtLZhRNXR{;IZb=#o~r{LX|?3|(fGsC{(A}9|Z8C0`Qe8q1GUlqIz&dYZjx8wmf'
    'xIJ36lP<<HX<qGADO5}hm-ucqnv^wE@1TC?G_z}k9H=*^YPD+EQ;kW!ovH-K$_4F*9Td68rxu<_G>Gk#-r%vcXBah{pzMdgc<gsj'
    'aWgeSt}b9`<j(S^eUH0o%cZo_ZB%~^?R5X-FP^<`93il&dqyA&yy?P+0db4x?45<EGTZlZGyE`HOdN&ByG{5N>3Z-<#l?^Er7XGt'
    '7xlQi)F>Hr8vR1U!TNBb5#Psnl^$Q_$x?+{tE`xZ1$Mfn0^v@7XyoG&q%ZLp!sKnAkn(6Ec(7CxQbsfldn$bu6m>-i_13uKW+%e~'
    '2Q$ER*yhE0rL0B5T{=@ydL5jrg~uUlO$zbG);1LBlYLw0nfx{IS-fnGDtotM92ha0pbOoEXPmkMJXPi0aOQh944T&6>+P-oAeM++'
    'zC7aJ>{zcYG2LhPpmg=m{hU<ZE>5~hJr#n|pd&#>P}h5>&UxY+2hjixpP-#({C)}Par!Wgqf4;+(wvFnza=)LD<|!+8o$1NR_nl5'
    'Vc=K#3yI6w=L<-)TwRXHWVGu?MAO<t^z4TS63I}V8m=Q(i>T^%j1}_z8kh}sW+%3+npvgb6q&wepz%UZTbaHBcUW`}!H(5HQ>WFB'
    'n2nW8^jrls(0N~eCeDF?6;vBZ7Ls?-#KDU(tdDn%sspF{4!e>?ZP|>O&g&2!t?G22N=7#Ei}%jIZq#m~EpXmoV<<nbi+=E#N_q@N'
    '`3{%UxApd^w~>ULNO@KbLjaAWRYrZ{<z7}VcKg~ixGLu;kQh$*fCrI-0rqCOGQw-&X3>s6@oki&$8~@lHKNSaEyiON^&$rK43{6m'
    '093jc?0KS?Vtbw>*fLOdHe1eBCRL&CpSkvzlY{Q^&Ye5Wlpj@ac*2&vgXCoaj5og{vPq9EZA4C4(-%wBK5c14D16WaXmUYGl{(uA'
    'e*wQh?Dr7JmkHknzeK=N1@dyv3BoT{;}8*aC+h~0EVpfRDHoB<#;1iuIFimkmgc^9rW-A-!(ue+Q$|{LFYO|CBX5Tq+q2?ht>=Rc'
    '*i(w}FtS6bo0XzDgvp|iY5mBLCslqw`DoH9^oZg~$@@)McygH2L8V`?2DDG_8bvB@hA&>TXQ6VqbY6z7;@9$u|9W8tKb<c>@y|!='
    '^=fu*=z8Ri_^0Bf%p~&zmAOUH2_CXC3dG7o@bd-_IQC;Li*qB3PDU$@&@UTox0%>y0{$q^$ArJ#Rv*Y$rJ0*CBpo6ACh~s#jdhi*'
    'y^vIp^Cid0tuaiFCAtzO-0W<OE`8}jPhs+b1-G7*wqt?;4zDFM_-Hek;RB#wMm&L~c=NurMGa>G3-xI=TbJ$8dsDl@?t%kfnoi;g'
    'vhml1i$P+7sSRR%(Yt^3(TEc=#HUXx&bmTU4-Ak6?_#n6{a^8Z3C30Fyjhg@>-A;TJ3O4uuR62kp^+7;!&NygS1=8do5QWcVfqWn'
    '*22q1F+Yd0Fkj(K$`7XF#d@BOMP63>`He!~e78~l+w90o*!HxQe|~lP`me+7E`)fLhH2M9@YD3X>3n}fv)yB7K{}MtgS2;E@?px|'
    'a5AeXI*j{%{dV!{^zrG_mv8<DhM0CVtQqEVp1N)g2T*=WK3C=0HsZZXDu7azh9ASL+{f2D__&%AQkkpvW?rr;+K1~=S^{(04H<<K'
    '&?^YS!tl-In9R4(xLIKeH42)QzQU)zm_b;e@YoY2C=UZL3)N^^Dtu*Dl}6SbtYQvRd5~4Az}wF2;nUYop1yL{8^hTHgNgwrb~ubL'
    'CLg>y{U!b&@cLP};40VM*@AQ)k-~*9TQ!-H`-7Wp2?n1~R`TU#NzYsG>&5WZlNZmQ{k`~a`t|(9&o7=md+~2cC4kkh>5-YwrZ{uc'
    'Nz;vv2Gur~%Vs{(5Z4sI;;~!22+Il~?@c|e;^gk|?(KUCdlIPNQObu{bS!lOZ7q=^{L|b)wJk9xfI9L_$`aEHLlCMGhT|rjM2~R3'
    'fuB4>KM(V-fp+4pdcjMeUds0hQ<S04m0L)MGU%b`slK7dmi1O?Sp^G}1SWKir_%6H{iH1p&e(zdoDL7L?QH3yj+5zh4q8laHUqy}'
    'H&VtpFBBY?cH2=P93Jm}fb2a->a91I^O7cu-VO%A1oPvbPBqet-v`s|WAamr@w})x;D8{wjl?&_p?jDL8S|EABba1F#m!Dem}Umx'
    ')P|N~ggZ-7KX;H@g%bF8JI;nyoj!i^;?-{F8;`Q-7w!Fh&d0^*L%HW@SbgFRDuC{RQlWN5gG9tr=x5|$$>(RoFr9)DraBG9uTfQH'
    'XW0^4(#-fbmviDrrz6XB*WYCIqn}M_$fz(fCm%MP+<Dd2g*oLPJaS+pC4}bnh=`}6blpme$y`If5DT{s$*&P4B59d6x$Mjq@~K8-'
    'M;TvuR<o2KQC$Kq_;mK!(5Q~BxJ?e%tA4zQ{+>W=9N4E5-1yMe+gqQ|I%ve}_lBfJgQbTZlw?8`w0b|CZ_FZxIpF0)NFg(h#nMxU'
    ')l9Sb8W+vZ2Kw8+kK5QR{BrdQ6uc<OVwA6W>*0uxwi(G1lo@Udx(@Yr>9coR4rN=WFT|X`Cdgu>U;^hsaQ5wg!5Xg74>Lj5seYSi'
    'CE=(^VgYM;52QH~d*wu<Jd9v^_Q~ZXa=~vG*jKuvgmKkF8F;5#D)x@H|0;F({Sp!^hi-z2a;~@DOB^U#ak(LsY63fLeJBZ5(F`pV'
    '0^34L8Q(PpSX<L3vq;_u;FU8tp~j)FX4;gYs&X!GrS)ZUp+ls!ISyS5RM~_qh+nC;5?@jH1X?1@U)fUFd2_C~EP}Jav%tqAnr7?r'
    '-x;>i>tEMuB~<c@$@#*Y37u8s8!Jm;r#t74r}m4tRcIjo+R+L{3l}ep`*{B;kG_?`;|K8k%sm@y`L<@!qOuN{fiMxYjbAH;+v{?)'
    '0@tp#7|q|_y3VbFp+@U+b%8K&bo#K}a1}g^RWn_N8|3gENzTz$&(5!G{4Gw5zVqF3nuQ{u)EEbWmm62nxy_@V!>58+PzW9r56N_k'
    'K4W)w?v*BsNf{{KG2wYoYShHhz&7)zK&TNGs|~-%Q9C+-G@2~2b1F-F6mXGJ2ZmSA{7rq2(waqIgbN>hnovNPU5sUMzdPNZzwNO^'
    '<bnG3)=@|>rC{Rd4%A6Zy-rtT&+PVdET6a-H!e>P(uGCq$OFR1ZJe^)(6nX`zoOE~vVK@j-}(n{A?tcS`5pCr`Mph6H@;yMAGA|P'
    '{P;FGM|LwPFSeSV$d>e6PQUo`*rQ2orPZOm+R+3^Gr}OcGZ7Fz^GwcYS~mjyJH!4Aas-;pEJP`&p}gZd(oQ;#PO=pdWjKCsNv}{$'
    'ESuzPEdY_P)#!OCNZi0fQ&J^cnpLjwfs+ei^6b-$aLA*vAR)wFh76-qS@sL&$dU)b>x}&<?vZ=7Pq*w>Uf<5IhRgXx&u%=QO5Xz@'
    'I<p1MUJr=n8SC8wKunNt;2Kt4H8(gY8JfN<gn|%kdf#!~6Iw&L=ua9Q88pD}K$0GhRshIjX2{vl1l(lyZUK<;qk?Cv6PVpYHEtdp'
    'Pb_yHet@SNNSW3>rCf85kWX$-0?{Obn;&yhUuV7vybH9FF`-_F!#h#DnNLu-!9r(|&1Im|Fn;n%23DBCwsE>I1Mq=3uoYtSQhrlZ'
    'fh2&WQw6``vKr1b=e(4+ZzViZe0x`1K-<3(ep0bLY;VV!ZT7MnN0UVCu-bJ?%(AsT!Z>>+nhG*EV4^j%ZN9EGQ^A(jU{9M%-V}`A'
    'Sqg+Z=<Tg9rtmeQeuu7lQWLAOiFC$A;8<`GO)gWTOPnz_H4a#QVwBGz)U;Z%w=MrbnQ2?KNi*d@Fdyr_j_sck)h*b1+rG}UZBJ_6'
    '!Jf7@n-<w6!%;9x-*YsKmgda-GjJ42*}~MaAfPPlAn*3&YcYGJ(q+Z>9u<aExbb>xlNx;_VY`MxT%6C|ZI+uV9wD+pRv@w=6;wm#'
    'a%tVu0jG{4Vx?>3_aTUxi_}nDm-zE$@gv6F@JLWeeKnrX#@l-4Ux_^J^o^py+=@j4<=ZQa=O{?ilfO`!@toQLm`M#rFqu{6{$7x5'
    'xMdu?yj+{M;8)N(QtLXM=2uDg%61{5udhZ>nueB02Ewy*+ysmUyuee8G_%kFR4TlWHn<ECjJk*{ru3Yix>N*dTc@08&%uPLm=YQ='
    'qsg>fwVANBU6iU1V89g4s)yR6bAT|-ma~c_GY~Vfs77hnEN^?gY+o*y^Qi6Xt!Nx6Sr27in9Z~H(IByF6J!n2z|GdMFRfn7u3V0$'
    '0Zf2f7temBpJzmZdN*^cR<`vdoXbf}jRaJZNO?Q9LM)logk7g21e8@Qo)x<b>s)B#J*-vc;n?Eo$Z2RJ-6mdxo@!HXwK4j#f$N=-'
    '03aiUUU0~&UQW^q%(Oa+dfxQrUnV}7@9R*10bicUM>*|`Ef%U}a^ilxDp`47ybjI%grTZ<P7pITlq;Hp;s*~c*c1nIQ|cZ-ZXRAD'
    'CKOU~4TYOn+0?lOvle&Hn}$pwZ#E!BnUN|(Wa@DEq#vJ|yW}%CEKo%q{C$wr8~Jxk=F4PHx7ZP=ra$+Cy5rbeZVK3$BlAztl^>%('
    '(hT9pBZ7{%5%|)geX%qL1U#|SR#JYgkzzkdb!Ae3?6RVRod~iT<5plbrF+p`j0c_z1|x~_=~vl7-<-aFGyLtvlT%9zBE|3a&!7JC'
    '>d~90FP;w{zk2lgueK&83_SkG`R~<c0U?Uy{s%PZAH?5S4`JkwAvd$fFT;Fz6Wr8Pa*wH1WHg*irc+JLJ+U7)M%(mUl;U$kk1#4|'
    '2lgrFsQ5>bZJIX1&qY#QXK~uju3_u~Z$6IU(~Mi5RMnj)B*%^hV-<#oVeU%h^Nvns5uA;GFLKJRG>hjt-^|;b&;f9f<`VSig;mhA'
    'us6Tp^9j=LLt1-@8xO7^bY0jz4ko3ns|7O<pS}#30lmiEcRR42`iN6-p=rn|x!|~h04GKid$iove@+4y!dW2f0aVSjSaT<?gMR>|'
    'LlVhh8-Rm1KqnmgaU0RNIMkw_M|{|!^IS`)huU2S#TC@peWat`^^==CTR6xU$)j2XN~sV&Y<m;#BMTd}x5^3X$>1nJWuAJB+dRvZ'
    'PpG6=nHCO>=O$Oq2SG~cs{G=45D1S>>8-h0z-cQNeDp%qLd?~Re&mbiW!y{ZtMhv5UG&pgy>wb1U8{$#)jx03J2yQfOrC<y<`Q5J'
    ')VRKcwOUI+uQ-aD3`B<XZ4rGHNDn>PKy}sgChGBy75!)OljIKSr64v_I@KQR#kwZ4iqu|ihhF>JZ)Y=T;9rb6*|Qc*-FEVG`&ZNF'
    'Ae9={)_RDFcUsMcU8}}G^zdqMer5@_j`?7dNkmCig&*7PAJ+dfgaGz{|Hfi~5TdjopcI`RPuMDU<!1vBNsqHfqQxpuB2oN996%#B'
    '|6gUjuQlDX>)w|n?d{R1T8irScyKKtxIGx43YKtt9^pTsa|y$EoyFb<*K`JU=Y?8laoyKbE2Ku^wk0td+I=gnw<NES{!JZG)~ng2'
    'b{M~@hI~&gd43Ktzz4shT~??1&2eJ2Dq(kEEgA4<_Fsw!1VSZ}V2cTakXtO+OA4)OBU(v81!`^q%2E2<ogsQ~o!W3}_WBALpPe&-'
    '!zb+Uwxv{v=$b_q66U>a1yl<ugs#XtjCwD?B+qj^y8xR-TV)a352;9SLuhx<r6nuhOJY1waXM&(pF*^g?iwbVROs?Don)#T=rmhG'
    'p8e2+@b<C|vnzk15k6?c-7lS(SFpe^dQRkIB)kMnOS)Nmb?s18-)D+4^tR2K>2R`16?8YOyD;6=q)SJ)(|kGpPzfHAAF5!zy0DC%'
    'mw<c3_wkKqc1Z$;=1empgEX8|<lrfBKgF3j5qy6V=E7o4*Rww*a!n7Cw;X&Zw=!mew%y&?2&Xk8q8-~mTgk3hxqqFzJLfkcYV}Ap'
    'USwokGi`xGXBNb`$bWmK!zLfUI(_se44G^d-Q`KQTibS=FK_?2X?87f<Axqb5qCIJK%D4I;XOve(eGz39{)N#{dd!S_51lxiSLE~'
    'sYCY)jB-IX*Kfo*Wo9!+&ea{?OLxsz?|X7WqK!n1oet~WN%+WecIjBVbU1CAKGp*GXmLwp_$1Q@D!iWA0-)wJSdY$5!@xbA;yF60'
    'mWIJ9W{4m<(zVfwt_sLxQ=X5;9{?$7Jl|mU=TGlTpf;imrUuK4^U}~sQ#+a^NAoI%016n;v?|Lk@l3-4J@n%L6W$iI8Xj&?S~hSH'
    'Lf-&1$go+4J+0bei`@k&=<#wspMk>3@T1iXsIS>;FJ89;_;n=jaE#~hlp8{5pf{hE1rQY=^U%jcCyJLwIN~9{gvm$DA1+v&&sN|n'
    'EyeS-wA&OpU_`Cc=Wm|A`MY^i&EA0!_WJ2Bx{+6uQ4pK4BQSSHi=d$(mKM-&X7hPrXr|d6wo2ejVTdcN^6lohdvr%?Jzt_rH=_Ds'
    'mQ;XEn%jZ2C~DZ;Ht%6yo|o%SrP-QZAD~xK9pWOGE*u;;i*vJQM{w7nANTUYaGx{K@)WPjviQ&cq)`rM(_uA235u%w&;KmM?q3un'
    ')KrI1WgF0tKvd}%NfB1=(|b<rYW_be79(?FKbgbwX||XwKUo%QWGfr3mlv~fVeU3YM=D;vc>VO>ZGR0fZMI7VCO4S(7JY7)RIYJc'
    'OxUKy7<Wj~Etcl+9=QqGVAe=bMYW3KVgpz%t>U(q#se?-;(+J%?Sdww1Q)kEsvvu2z)VUn>9BTgjJ-4ld86{+mH1D?1FnJKIP@gi'
    'hog%Bf_ru|FMV{SJT{Y=rGJ0=X87V)b4_;n$M4U7eg5L#o)7JAN5=zt_4?5-klgc_e@l_!Z%<$U_UO&yzZPg|!*^yMKY#RW`17Nu'
    '&rYA1=Xad=Y}nh)XS<sYE<q(FiA-EBYv3Lvk?8d8twUJk!!M@r^&tXC-D)DB$`C~lR5qGrGGg6kJ#F82xW;h(3^5{^+&I^rmAS7b'
    '2T($#(bMIAEV^~rKiUR}y(+jrZ#@sFaxyfXWk6*pan_^uxp_lon*$rI4kqCt>J5jWkl?<a>2CdCc4}`x5kkUV{E2#S_@im+&p0ns'
    'S8;qS7-w=g(1o?2l&}jJ@A!lH1>B;cCu0DuGt9PfvK`V(>VMS1v!e&ndH8UMBgM6nr7~OZ@I$#;l=H)tIqA!bLoS$IxluKq&ET!a'
    'L0R`Zp3v`%tUSZeRNc)V`*6rt<U_m+6Fn!^P#ADpK}$ibJ5dle_4XF-+TItg{JQr=HGeG$Rw;X{VME40y?*j^F<l<eVeY(MuQp>i'
    '{C*DCC!>`ihK&k4Fg&l!OiY&r9@rmY0`W0C>%9N7%H#?a40%obRPO*Wcs?6W=c9KRThGmpha0nuw~w_po{Nf?#x7+)?^F1a{N#2h'
    'xO2(Pt_9!iT5z><m8+fWtUhjbFS=8$tLbKVv|EjEIK7hN_oG$ueQ|V>C@emWVc}%W3*anwUHhFU>+&DV^YQkg<<M}mA9pIZd)tfI'
    '*dKn)8G)nz(FhJv%_nziKG@WM!3n^I&z}DD^3{vSJt_D2$+Krh!hKExEE(tJ_8gj99LNGGpw$N+VR^O$NJ~U_xLD5q2@Lc(-BnAx'
    '6((~~AQ=9rLNLtBks*cWB{)~MBy<lsPVOjtV)&f#hqkFxxL?Ehtr64B43bbWnLuIwjQR51ypo|=S}qU7>p)Ry>0)1x3hon-Bh1S~'
    'F3_1=LE>_)Gmtk(FAX_Cl4%55tjDL2$Q7ssZ|(nz7BTns<8o$hs@<v`Y#D;#cHu)eC0K#`$j)Y8zW1&zH~X@CCV1g&Wxk{nYkMbI'
    'A1b#>ZYRo}#3l9p7hnYp0mse_2YxN52k@P!!_6&e_*gEMniM5MUxMyB>T9d$+7owvwJN#(mfwjQ>$C2|cm337tRTWQ;=7I+lk|H<'
    'K#*0bF9lQsJcf^k-EJ5D$yuX4jz-UsIoKNxm}79^au*(lc1Q0^s^8a%$I#JU_hfRd6U?)h$94uEwFzMQV5z1<PZZ-PML;L<4EQfk'
    'CC2@Z#ffwU#A~H$NF0i$)_bUFo}vbGa|uEeU;=a3d&L)O>YC*M8^r{;okJp+2XNgwn>#2Z{yPL9g@Ejt*~agH$5%aFY%b2xya?Pl'
    'l!}!(T*TDUg+0bUfAl58&T~*Op!(hUe2ooJr#;eV92f417aDFp1V0J<c8Wj0K%r})_=4B?t~5*{WQ5V}wp=4EY}u_*oWtGk@oW55'
    'CF1NY_`bi9{rgf`)Xcv=GA5&Sa3<iZ8M`3zg6O{o{vr`E=&1tshQ>`zUAHTpDkI*-qq*t~2NDV$rRakr9a+e60O;KbBheEg21YXe'
    'd_2RlgV1b9MF^xvv|4057L8UM^G~h*5Cw<B!bxO9sz<?6#WAnCOL#tAj}q0e3hw{y?&^6OhJol`vBW~9ss$t#BsP|cp$te2z~DA1'
    '6-tvTZdG;QzvFkgvoB840wYV2NOR}&x%c(#^MH6K%G^pJLvPD%3^bPZn(t|X&?`_6^QdJxekm;U*)lb|lF^5HBf_^(YP5CkV>w$='
    '?ay0ri;k#wp>;ee(%e_Qd4XzH4M8ac06<igt181zA~ZIT7Xk@I)xS(7>f$KmKx<!q>@8AqDta|FzI9$~QB5ao)9fm=N5{PalkiK&'
    'I*HRVg2%ju1H5E`IV7Y9ms)Z1plbr68j|jsq4W|NzFxhzTW3bQeu^;vgJO+lpkuwNl5HV<HYV96k_p@&t&;AMN#E#3$2^Q!h+~Qa'
    '!xA1@r0k~zvBwb2r0y4N(aQ9wLJ{erf?<u__XY#H|Klm}XNDg~2jw|G?l#~eoJaj)&mTolky1Qu;=I))j5;&JuJ<QOi~2~zp20BX'
    '!o1jeqw=;XT`)tLf%6=;;np9@(~`8z=XFJOn4D6Wj^q>7ux5Ux0I?Kr`<q)Iywd0S^s)8zfAz`J@x0C*R8;3p`*ga|)sbZf`m+G&'
    'krzi}vroJ9kM6o44(zp%3!sR9ALt}bSK}{&UO%mcqmuw-4Ez}<GPCJ?j3Y1=Z$)K#)ryX%VA*4Xx%1{^zX;Xitv%q-PHmjG^M$E#'
    '#fd?kRwGWEi5JrD634^1kJ}0G<0V<HsrRlp91H8T%BI4uX-GRp<g;80xsosCSXc)+YJ(u0$TTRCw}O@PIUgokSYaOq!%l=22`wtD'
    'XN<JbD4%8zh*24zThLu0$0g38DFLCsLq#pg1=>yaXZ^_Z{lV;=H+hK2gnP(Z2Pkxqn}LSew8qHAv@Bg)jIN2$tXe=&%cCm$`*#c)'
    'NH=*<V9{USHo~q%'
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
        mutations=['original-path','original-sha','journal','intent','machine','volume','mount','owner','nonce','claim','shape','state','version',
                   'environment-mode-only','environment-hash-only','environment-unknown']
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
                elif mutation=='environment-mode-only':recovered['machine']['config']['metadata']['cloudbench_source_guest_env_mode']='owned-capsule-v1'
                elif mutation=='environment-hash-only':recovered['machine']['config']['metadata']['cloudbench_source_guest_env_capsule_sha256']='1'*64
                elif mutation=='environment-unknown':recovered['machine']['config']['metadata'].update(cloudbench_source_guest_env_mode='unknown',cloudbench_source_guest_env_capsule_sha256='1'*64)
                with self.subTest(mutation=mutation),self.assertRaises(ValueError):
                    creator['retirement_successor'](args,journal,intent)
                verified.assert_not_called()
                self.assertFalse((journal/'retirement.admission.json').exists())
            recovered.clear();recovered.update(copy.deepcopy(baseline))
            self.assertEqual(creator['retirement_successor'](args,journal,intent),after)
            verified.assert_called_once()
            # Model a separate admission for the owned-capsule successor; no native retirement ran.
            (journal/'retirement.admission.json').unlink()
            verified.reset_mock()
            recovered['machine']['config']['metadata'].update(cloudbench_source_guest_env_mode='owned-capsule-v1',
                cloudbench_source_guest_env_capsule_sha256='1'*64)
            request.update(guest_env_mode='owned-capsule-v1',guest_env_capsule=dict(path=str(self.root/'private-capsule.json'),sha256='2'*64))
            request_path.write_text(json.dumps(request))
            after['config']['metadata'].update(cloudbench_source_guest_env_mode='owned-capsule-v1',
                cloudbench_source_guest_env_capsule_sha256='2'*64)
            after_path.write_text(json.dumps(after))
            verified.return_value.update(guest_env_mode='owned-capsule-v1',guest_env_capsule_sha256='2'*64)
            self.assertEqual(creator['retirement_successor'](args,journal,intent),after)
            (journal/'retirement.admission.json').unlink()
            request['guest_env_capsule']['sha256']='3'*64
            request_path.write_text(json.dumps(request))
            with self.assertRaises(ValueError):creator['retirement_successor'](args,journal,intent)
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
            self.assertEqual(set(historical),set(HISTORICAL_SHA256))
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
