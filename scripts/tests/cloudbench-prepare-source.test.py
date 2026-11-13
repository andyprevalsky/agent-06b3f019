#!/usr/bin/env python3
"""Offline owning checks for private-source preparation; never contact providers."""
import copy
import base64
import zlib
import ast
from datetime import datetime, timezone
import http.server
import json
import os
from pathlib import Path
import re
import shlex
import runpy
import subprocess
import shutil
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch
from types import SimpleNamespace

HERE = Path(__file__).resolve().parents[1]


# Immutable failed-ACK producer and its complete literal dependency closure.
# Fixture bytes never depend on HEAD containing this historical implementation.
HISTORICAL_SNAPSHOT_SHA256 = {'cloudbench-archived-machine-reuse.py': '6d75c63b0ca0aba8a74cfb2e05256bb0c757593bb5babf6238170d6ccbff83eb', 'cloudbench-archived-reuse-effects.py': '0ae76f2f78f7284423e09e8610fd20a2bd4139783032e92df7d1d11a22983b60', 'cloudbench-disposable-controller.py': '2155f76fa604797bb1b5de224a4d97d18c34081b202c7fc51c555d7aaa3ae43d', 'cloudbench-machine-readiness.py': '5843e509a64380711147b140c346e81622a2f904b300d3af5a247415f5488797', 'cloudbench-original-volume-capture.py': 'ddde11af81f8200c1987648ad19b10dd5aa893fbd6e05c6a25ec0c7ea8c12c58', 'cloudbench-original600-runner.py': '04bdee6bb94485f58f7c7305860110f817c7d37be23bfc198a5c82b62be1eb63', 'cloudbench-prepare-source-create.py': '9a65c6bd2ddb964998257b1eab58316b403021ddc3cb4a86059a6615139d2384', 'cloudbench-prepare-source.py': '5826b7abb0131c2f3565df68d9bc00b0e28712b2ef64999996be0b8f8c6944be', 'cloudbench-select-snapshot.py': '8037c6cb618c772a2753c1abd80500eef4e465e17cf39afa6a86949ddfb65128', 'cloudbench-source-env.py': '29a8e3bffa36e6037ce662f867143bfb81a749260a7636867dd820446280c382', 'cloudbench-source.py': 'e8a03c13e9b59379d92a71502bb92c54126a64e1655620bd639d6b37eddd1ba3', 'cloudbench-volume-migration.py': '5e00ce80101dcb21b1e746f4d1a4de6fafdbeba6185d885e366e10a9cdbc1b54', 'process-identity.py': '102aef0fa6727acdd6668fcc85c6189f5453f685e7a2dcfee33af5a60e824656'}
HISTORICAL_SNAPSHOT_B85 = (
    'c-ri}YkS*9k|_LFFwV0>G6pHhb}|_{$gX136K!nEucTyVR?>q&Bq(7_0$hTWt$1{P`&+lZqCrwl=Inkr*_}iLx*Ofq)zx*cPmjj4'
    'YCXBi%kfP=TaIsv+kDcWXYfav_m}y)&IgOTN5kmR7k}7W*UP=DqTI{N+h}pOx~a;i7v;qx{J(e0yv~={_vmG$#);nWI8ip47j<1!'
    '<sf>S-{#9`lF#y09zmySy&UItR4t=wHi^cwteDpW9uvkcr^{*{rRj9NS}*f7jf(lATCSq3EUQ(vf)VSBQaxK<FS2Ew>j&d%ai@RW'
    'WcAIgxYED>QCFq@QPuLLMYh6L>ND@)r*5<~BQMt_4ozKFcMF)mym*r>7DajeZdrZ2JA)UvgdavHqbQ-Vy0DUB2J7ezaOtz#yxSYV'
    'r1NrhQJ%i|Vf5w@T3!VAg!ZC;dw_5`Jv%-*{L6^iF7s6eFrM^ptJ!*<_op!OP5(MC^CbZY+rK$H`EhjO4V|i?QyLoE9lm=<jmqq{'
    '=zq8=>P5cn&(<IN)B#(Z9iIM}o{U~mvxBGK{3*-7-v1{5(|CIIP5yMcpMCSEuP0fS|M|)OpPx>@+JAcW?CY<1D=*4PK8?yepLB1t'
    '**cE_q8aQ$Z+KBg@J|6Rt5rnr<PrX}%!)dXe#WPx<+56KrI#6UoRw8sjI$Y!tHuMstd}Ki^kA}{FKYGK8g?pupWoHV*^++eum#zw'
    'TGmPT;!zC$4{IA<JnF?!Hk(x+(lRTPSJ|x2djo(&HGy3-U$1Yn?lSw}eO1tH0B@gs^))pZ+~gl8#dTh<?C#^LoEFz9juM(ZKKIvW'
    '^`2Lg^(^m}+1&3)C^~?Dr-;+tdbR8lBJM@hSjPAwI=jgMdFSg@b~VeRy37{!4eSD7aUHDy1K_AGa`;v`z8gd*jI>d)imvi$waj6#'
    '6`)X*PpA2KRmV7DT}6v!ahuWk9_PgZk4`qJ_dYC(6&#h4D8MqGRoNuUWC;;`ub2R(D5L5MDGA~3;G#_5ogDpqcs5FpjsfRnz0L`#'
    'mc?~ZX0xyN_xrG3z<Z!ruzLndGMz3$!UK~v{5hVbY;y7Fk{eoEoZWKgICAy~AE}cqUDRVa)r0x_NwMt0wDV-Y`qTb?9PtZ<d-=zr'
    'UZvH0`YHY0IpN3EoYeQt)bfwn82T^M2hI@=8%>kGUw3=ffuj>jrv`VZ?mE!xMM)CLIl6c>SuY7~h-^pWo2<OfCj@#ND2EecjoX-^'
    'S%pTxw3uhtxqA|5K1B@(vdYSFu21o5*#mT$z%>4YPZ=CpKqE6dgVutjG&t=1f3J(BHP2<fsOkdF|6LsM0gYshgJr##6|1iOi8wmw'
    'Src34gXwxUn`f)>4YWJo@BcaLPcJ`x{p=pw@_0RWIy?{gRAV}@HAH@JEoN$FDtkPK^Zvo5O(u0qn0%<4O#OWS(xnrP#hYze!Ihe?'
    'QoQE6!V<($^#M*;eN!xAb<eAfnimt;+G2v|lv@M(7I>hnUhs%7s+8VXkTh#Cy<y8&i2aCl_^Vnh5K^@7(rN%xgykvppkaHl8SLVb'
    'W=DXKPKpT<run)?5*Epb(T4&~37w?~h*M41ri>xGGM-*L>tedCS1_;EaHydLw38X}BZT_-WiPnSSzdOz6&<SsUKTxoZIWRaTCgTM'
    'c>vu|BRp2p1P}z4nCba53~C_y!XZTTJ_1H=0<4OKf9`_4xtet?5I{h*mQ}Ty()!H1>op<}Jo<FsYi$nv1zrI#UzxD{bS6w}OvIg{'
    'MKvqNce_p%xrnU1>#AwNRo{!?wu;~nJXBrUJ>r^{GNHw?0xq=9<tL)j<myiS8sFr2?cju+Ij+lky+FPXFi1$uEW4}LD}RDOLV-lj'
    'v*mlZ`5YVp=1q1>gN&Iq-LtBu&_$mg>FDxqDK*m+#Dj<X^(3+w3hH-`3?I&3+5l4b29ul_9l9xK5=hRYw^f<DKrn}@UXKxo0O&Cs'
    'uWE8fJ8=c5I*G3C;NcQ)K1DTr7zsU^6ysHs6u_xYki3`|nusK~&T|$hQi~iU7BRAk#AUOWVa9;gCl+f4J7%w%2snU#nwYJmXD;bM'
    'PRsf_{&YV(28IKWC(Tw?GxN}Gyv(nGE?Euvf!k;S$0O%mNDQSm?*;g3iSjcJBTHicXtbFX*;N5|OOe;f#iO6zo{Ub9U;jLM`5d-g'
    ';R0NZdvv<{0C+qndw@%@Venu)%d>L5fCD+r0WZc5LKw~sd2<Bye<Nk-s_6rtSI5xx77z-qu9Vq|adiWSF$U&)S;EJ0gOI}-&(@QC'
    'l62t~UYBrMCe)pNFK}tr@BHHe35<H+upn(W{nICO)APqskVV;*ZhXE_lw@q54{qDI`Zs>(**<;8T3p~`@;1V^;o;ru#|CIG`c7R!'
    '_^Jl9o@Wab9rRVt?U-&ix;tcH0yMuU$0&u*7bNUUTa--dR#FZULj~w^M<W8=o53($Yu9?wV}54soPK8Sp1tJ8YMifF%W<Du>mgnj'
    '7^yMRIn-4^s~OAsvcDv+=z(#O8th-7^vWa>#1>eIprPHfj;6)32HaiU<fXz{{820;I4<Ri&Y2poDra{QYac*-t7dSX6nN{7x{46+'
    '*|I=J9;Lj(*08{*=WzcGgty6-%OXd<?flYtqErNR;8iifrwG=b`+_O6_wpv6P11T?E$GFkdwwb#+ZamkgHjK{=Ut(Xd-iPzlGGO?'
    '<oULTKk&A<kmoWyItW245OKTi7Z|~I`GSp#5BUPND#yhv-{m6#+{U*6S75MW)yn^{BOui4*~-Y!+_QI%%nuP+6f$8LpRD#8mj?+L'
    'IM})7Lo^>8LY@H}6kNR$7fegU3O$<Kql78u+IJb~kUWSTVj=)Nhj!s}bF}G~b)acI&^nvV?7>Ke(W0e8iaVMTA3VG7#3=6Y4#6J?'
    'd-_7`eFAxoTRi=|R-0A;%<)uLhESMovW^4|8~ro-q!}#$yMYf1M>q+?h7lUb_UNYo#>;yThD`C)=Uhl3N!73YfdZ?v31XAFwXBt9'
    'fjpwM=s#LSA$G{F3@bY2y`Pm_WX3Z+2kQk+)?S{)y-jH|hVCLP3N-+@1NV_ZSB10&)rEB;sg_7qPkqcoG29gz&+G`Hc&8|Da#V#)'
    'QtO)?!g6m;f(6*%yknh-&ZXO~$v1RtMFfm3W4LSRT>2+MoeFBsvt<DTn9@nH>VP;<N2ChXN6khZga`g^8}|1*Z1|Np@Rg1_ZW_qZ'
    '4PJY+piXb6EpLI9zuhiU?RW;g4Q7=Ii{(kwdctGpRa1ZB-~mDi4;9S8zN-<$@+I%BT-XmiZTf@u+!}`jQDfs7LNU5QFVsylFKWVv'
    '@P|<Z(tR!-nRUs0Sh6qh61Bz#4913K{sCGpvT?Dxix|BdU$Njf$R-5ZmKFj-YQ=wt8>+id&rzDOs?Fw&0<708zs|;Ysg~=k*7PhD'
    'U3yqgt}RK_wvVbWr6?zXnt9Y}sk99;n!_L%#zPnmTL2h_I0bJgRxy$l4EYUGOB1WJM<NU=Q}&cXza9Wo2G_qj+rqLZo@vc94%Q{?'
    'Yxhe$ku*0RASUuD7qdF%KoRCOYc;r4^aqWfHrZOtvXZsH43w_Bn*lz_NSca!sS})@dWv_reIEa5FU5@BL;n61&_NADG$rBboagf^'
    'rFs2Fg(kl}Hlt3^h_qT(vl()NAYiZZF|(51RjYR;f!`lj-3dVp)e><;R25fEYLdkoHJ6t*xUks(P`5^1DXO6Z+Z137)HlUA5KY!g'
    '<Pm5)CQ&|vF-VJWr(o?f2|gD|3L>-MMCNRs5LIc>b40wf#9wI7qvS-F%{eom(Rw%i(gKr5-2LNvu4e(mU)oANi~XxUXt7s5DWm~s'
    'X|sv2V6>RwarKb1YoC!nZk{=sLA(Ba-H#l^^<P?89O@_E6FjtzgS!HkAv5dofVj*)r23#W=?T0>I^rKi*z@Si=wScJGx<;O`e?8Z'
    'V#_rjB+kZ1mUA?w66NwFr9pO81MLUipx3($a3@O7YRs(OsX$7_<k>k5-ca6J6nLA!`Tp>9g!3gKgeQu?vTS?qVtpX-WZ{zW%sE5#'
    'O+G8~Hyjc*mHPm+kw4@SHM^*q_gvOPS?lz!ivr}XaX(uOVNGiIuE8V!Gzy|w+!22#(2VYDpeIGS&YN$U?$K2p?#d0q?{>SM!hJ(`'
    '7F&ZfPu%Qy-+ZKO3Y!SSIg+SdYz^K73ABd8r?xRE^?Rr{!`BLa-}3bxUMqD}79^w7PF=d*R1WAf^5AV<E$>?T08MV5EwPy3(@DxC'
    '8qZdE1aq1QuJLxzhsOyl6sUB*SXurtTNaM&#bHURKoX2t5m-NGogyodm8C|Rae!HkfU&i2>p}A?cy*~u8vgcfR0JYQMbO9>a;Nyz'
    'h&)2ENV8FBUFamRuJC3WDJ*d;*#1Xi`K%3lW7BTPX`AG;#)9NTw%%&aJYlpOxbNXyjI$YC+i=os`hVF@YeZk>%T+@~58Lr^6P5a{'
    'l<Kpo6(M=twp78(z-pUztkAt{gU9i!@=>GLJ_p<#*`isV)o8&OvPPtR+9GA9O3EBY`|(yv?aT7Q2D(?JcCZ{TtGc$Wf0}P@P-+?I'
    'T$oUehK`KMLI>jA2H~A>L~X4R2G#Z7P>BfR==&Pk2SGmH{1kL|rq-f3P(q2G7D5lL^s~Y;glUOcq-dX0r;BH&dByESq33Hl-EFX>'
    '3sy*=X`K#;J)*UvqD%={b(K3pJ2=eOCdG6Lf3o@LHeVJ~H2wHSdGEFf%)d<|<;>B4=Pyr8;(ni|rMz{8idhsE(OsUq{I<mv)Ami='
    'a04}Op9VI&Lv1?9$^`dD(I9Jn>cF;+95}{WY8K0rZ<F!Oqo0@rI-6x(+cJd#dBp+Qzt=pxyy^MNQODj>9MT6Z2$YrZ98D*!+H%kn'
    ')0O8Of{r=!EMdoK+nWRKQgqNDw@dMrwtXNLi{$X#JKGO~?D2{C4_NjoV{1=rrviI#>i6_oIYu{qEo!BGsO>N6RVH#%`yh_dT`8Gm'
    '^Q%b~Er-#vL0@c7lPYCh5WAH+FYvM=tFOAU{5GT>L?@3_JQPy$$pFfe_!pb6;zAvOT7aW7=(%QnF}Voy(6CCL3me0V3)>pX%+I-d'
    '@;){1qM_zhY$(+hCqxzl@|QRE41IUsH|0u?_mNQoERc0leb-7{n{j3lmd<#yh^MNJW#nHq47zKuM=Fa%jQQg6CxHW`;J4dYr$Duo'
    'xB<T@oCs;*o{Nh|=;U2o<5~b}kxYDx|D8RuIv+B;4j;f7bZu7_xCH3}td`s#QNp~IJHmS6dYj;9_LT3-0yPoZa1fa47Ec~~{!9|s'
    '50Dg`mPOb1=P~q(m3YoLO{(VGv9XtJ$L8OF&KNpFekQmDZ3DS(J)f3ABk@v+V1|C<FJm{Se$7jurJL*U<1?k&X5{Wb{&B%-LH2@9'
    '!p`5eQ=Q<C<@FF2CId{0KQ{CTjf|^u=ha|68Zk}EiQ8f~FwAL%`grjL+?khZL&yVmB6q|SA^uI1DQ#SOe%Sx7tp6*FaQWEuwYRj_'
    'Sers<6^>;o+;(3AeW&Stskpu^e)3Lt#|<+$V|6Bk`xBq-J>`_WVb=VipnUNuYZr2KV1a2uE)^_>u#am%`m$IUx)NvzJ90@R!wFFH'
    'QpZJU&8N2J<dZo1GFD!5sd6clsHCA|!Sn7HnSiAw{xr7~xvWDafn0s{-s26mnpPctqcL{5z6~1N|6ar7rmmBjb&?fm+id05)&+TL'
    '3rv>fL7&wz#S5atKM_$^5LDVO?cHA!i3lA!pVgP1mH-z!9?{uVjqiy#=*C7B@0&o}%^mJ!vM?0Qv4!g^<lK94d2TMXOC8K(KMWc!'
    'jHR4G$^28aF12^7CXhkm;T=T`M-U%11az#RV>QtjW9bxIHbi5p?$bl<^4Az{B@7?wN%Kh^S<zzAthz?^PsFFsKdYXwp~ohkSO1Db'
    'EriF!AdSSGm(7~zA2b`yGf2MPKZyEKYY#Q|6xp3R!S&fPj52_x^{iUe$wAYdx&e0iehbIxMc7P)i3@CmCG<2Rb6A+SdWv+vsgLag'
    'Z}n_*jlX!LPdc_BFAt><&{1g{c~<xH5_Z(1Xc03V6&xZ_NIg+qhtD5{OLVQ~u`MZV3t%#94qmBk5g0h{J-H1xuH1@k2*flsKkr}3'
    'E}i4IjQ~Io#^>`!NRz&N0+R@ZQ4z&DZ}K$We8kU5&u5374}G~kI7i^44OAvf!Vf;PnSy$a!BFs<;$c+qq_PPsX(Aj4QB~7)O3}}B'
    'w-d({n@%k!cnf2xyK8Aj(~x3f2|Z3U-FOAG$q{~3C+*d*qJxo6so3Bx2hg92Bm6PEdF4&PkQ^4h?k#es8xyCOz(~GF)7>aJZilSM'
    'kp6twdbq0I=cR$GOAauRK)2CvIYEj~LP~*(h?Uz(w?DVqUSc4}zOz<VvY8drQrXjBV^p0#9}FmG0@Vg}2}f~1wTJFv!nAAhz){1A'
    'XNx&E`)pW}(4Aue`LfqLA3l8|R|<tU>Ojc7f#m~d(jwG*7muRHJO{-gOL*RnT1HVChNf#ZBE?%VN$8I_7}yqCTPV=2N%oo%Y&zP>'
    ')A6<2(32L4s3j&$^&(dp>giIyOPwOYyB<9vX~GHP01-&^U%Lbeex@F{b#Dxo{NLC)u}xC2pu-@A0|hs8LJ}mX82@H~U?4tnH$Ed6'
    'BDtAI*aiLS<a~?RZ4Q_vcwg>>HME)7IU$Tea*$4nWrBai6#A}z0xbZ7fsgzcPAf7tX@o*LukEv82pYe0Zc$Xp+u@V;L9(737}^O#'
    '2y6Mfat5+R5v%jT+=13Z%3nTU{sB7%SB3ogQuod#Df)ppdjD+vzN|jX@(Hj~iFIJ%LV+oWg<`0VvSLIyh0lwO_yV|S>ge#@(H>oZ'
    '&m%HJurW|f`if`GfNMZeC}Z_USw*L3hbL!yFGsIOXCs{$$Z=!Z${RUrR>?5rr~C4=@^!d5IMip*p_vaxpNKN0KccKdkJurKoud+Q'
    'k+K7K(R-$+b1Fm|B(C*x#y6c(UGS|2z3e?wZW@&30FY%s@F#C}+h^Np>uN@@lhP_(Jo?M%3>N_(?``UC;@x>1!(_6O&Po!nH4a|+'
    ')#xDhhs3b&rb&@m+F2(!S%8t?B1;tPh4mzOI&Cd+Eh;Jo&o*C9QUl2$47d!n%$#}}LxO!^#rH1UM}_3HJMq{%M`;u=n!_4izu4?Y'
    'q!TZ+wh~43qyeBnBm0Kh+B%>TZgUZu=Q}i0ck1>JTQ~HE#=VC+K_Pzh$yty2XV(H@?F~SD41!YFhd6|L<%$n`Aoq_=)abK)ZY>0@'
    'x0`#lolrp^HdpDu!|KODW}<o8ME@{Z7E@IFX7KN&4ud8Rf6KXZNqF;9&GiGM6*X@*_xMv6%7*bWKxpN<njWMcuMwnv8^PAw3<_bf'
    '*~>Q+sww0t4&b7YXY%sBV!beBgLrXxirm&LbCupZXo1`BR;3K>^UC$r+8jf$BcX(Va4F;q{3D2hekVIDuyISB^9?25H*y=fz-+sl'
    'Ec=wcrOdN0fJ0fnCm&r(o3UQd)m^Pu(JWh+c(Ytb#p=1Z&R{#yctP{KI?7h740F~D{N)g)6)WXY`e-~S_eH$&W&jqx;R<M3lK#FC'
    'G3=dk*ygR2L1!3iT2$v(#r3*c*MdA8RymAxSbW52rt-zTJ3c*YGwp3UzguSL&8y|;dVFg8(T&=3$k3nOY3qg81JuRmx;*GLpdsww'
    'j?1CB$n4?=tge1vEK){7Vu5#BO#pY0e0pXD&9vI=iObf6bA3?=akDG5Z!BQ9R_L+Z27=}Y))w<%?v2*OfW}F%@jp6z@ncg5=>b#`'
    'SHO`ES+PnLd)Y-vkgx#P6-O($9f4{jPxiO?qRM!!rik5OX)RTaxC1zv<5-<PixpQ8#p~$`kCKAt^N6#hYTdi|J7@vz_n|MXyg|!p'
    'w0Qz+?OU0G-+>_roLH9uFs=&oMOIvwskX8J)=lz{M(A$XB3M{IF2xS804few*9=$!HCRMLppc}~1rZxttm<f1p=nlh+R?B1vT~$<'
    'WY_CRTLo;jKfTh7#zRtuk_UpUGh1HYVnh#(W|BS<9?^F#{Xbmk%kIU+<kQppUjHBT*R%Ux(88jI|3`J@*jOx`JAWdiU)Q}?)he6e'
    '7_}Twv2_bWVA;4es0s9eY?HJD#CY?E&!50S?MDaJg!a*z&JDlCFEM4-9S#)hjt%zqq9@Seadf~YIr%zrf50E@aid09{}yAAv4Y@-'
    '_BYucD7YE7?3_RKZ#W&_UMiC!%Y=((J6eB&wi<&vt5rT<tSqBV!&cL5OGcZ6@I<ANv7iLC;<RAP*q_hXp-r(6@?Qy&Rlk5T1kNsv'
    'l}hs1svhL!ZLtKgkXQQR_3=+HzaPDQ@k4re^5Tc1pGPm#lhIG7qx9(Q%hBIl<iam}#vtkG4~Imu>>aqOs#({}jdt65244~nO`Ua&'
    'y+0TiB;}=@Y1NE1v=vwX$}{erbI*C`;U}05jO=y$LAJHS644l<jGSehprT1458jM!+<;F8tg%6YSWk0TE^&)d7<mGQTbpe-<m(8t'
    '!K^TwoQ3@W5uuR}xdZ)tRXjwZK@eMW(L2m9Q4cO!owi)c%j^SbzF9kCZ-oD0m7d(Ppz~fR$0&IiUEN`FZr_E&+Gmpv!+03Fq2#@I'
    '%Z~kSFl7X`Os}@zAXENJeZ1k);#^k2)|MqwrPn(|in_eR%o|ZATY;)E(I^o&Gb^S!ve$#?Xr-Lu>QxR`2r@5Z%2C4!_3qSKD_kut'
    '8zX8+mUHMRDR1f1x?%zhT3|8|ieOV2Jz!;9FO%qC=)=odBMd5OC{3s-bMZuG3@T<<6=rRuIALR(8AQh*ovYDSH+gO6k)Ia%OmYrk'
    'hC)rAbYggz4?q++LVRs&>IRM>3nuNCROo)PuSf^KhOKnKy;j9eZ#NIw?rnqPFj}qQLg@x(^Qbi(HDuSk?`={XdjXX})2E_o_dPG#'
    '#1MC80sx*s;9ek9Pe2lSfwIJG1~lROtj<RiH(pc?gB>-}nUX*XSY+2IW^sTxt5#{#@(<)dG7)PYrM9$7ci84i(i-NN_?03Z!gjhi'
    '0$FvjUb!>+zCekv%uV)6QYR7%3MWln^lBPPQN|%mlxl{@cccd?*Kq|szJBIBLV@!_!lHRP%3vsya}B8Qy(OhN;--66q=4L|(h|9V'
    '_C`30mTcU6@Y7;|{4AjcWuj50$^v!*jg>u1OP7#Zuhs0>t~Cv+#_qjr*JxWPt$kRmugLQ|kS<-46~z&o+DTrabX76^Z{PL+XBY0S'
    '1Jd4bOSD0?(j`>t)e_`tw#c$$UbPbUXJ}Q_DM6{h2`p~zYI6TI3!<J4e<+U|pp8Jr7$=QA;^<42eT1fUJ*%$Z>iZHeyrAuooaz}s'
    'J-D2JFvJ{LuGHxCPBLe+<Fa=p>o6<i0<ez54Dq(Rn;C{Wv;mJY$(JEZA;;wa`>;lvG%@sW$HR|M769y^tGQq&G^s~_jP|SjKm93a'
    '%TZTD0}R3a2-{8(2!qq~==9~$N!R&wC?AMy0j2XH)@fs&h4)2C%5uzMwuIY^JosC!bjAsO=tnO$_7LYd$#3HwniXZWOEX;YF74J%'
    '>h#uT*Sj?<XGQtGrQzlFga;mryMxVJZ}-XQFWz>$7)vvw5(}I1ItbbUH<VEVZH^S#Za8f+<Q^lgwFX25A4>#X_M!Kn)pGA|VG&+#'
    'D;>S((Uk2=RX1{j)a<tC&pkk#{jYU?Zk7&`EB@ax+wGV+4eR39ou)TOIVLUZUD}Q}x832GD-Yds#27>vOyTxf4qe_^v1Cyie+Ne_'
    '+u+NrlO(qqM&g#`W#Aa%OkB3eI!$VHBfYy!k$A-?8>brP(9}#DCUYKBc~plj-P|T%=>F|S?#%{n-?;sotk4hG?f@^_*y=KzTS%Ax'
    '8Acjx8x1iHSC!#rlV2P5i2F?o>Y!14IkA($QfWHU_&EZxvWGP6PZy6?%dD(X$l+ofp(Z!0)uR1v4QR4l4&;^t;9q+UB+Iqa)k+35'
    '<w^y>HzSL01enddKKIgm{KjZviN267ROv2|M8=n6l(Her*x6ZOfn@3QoN8Wb6<ZA6K|i|%E(@>2HXgbw(jR75k`1SH#;#%-*MIrx'
    '**(jV7h0<0&Y^VNTAHLKwc7-@feiDyPqXo=4PuyJQbFx};eD2B3l03lva|^0K5`k#S+B<As#&h=gp3%V;i4+*T-i$)WD8|2b~Kx@'
    'ux`Fl*P||ix_gZi)=)9~J@stQ_b)G793-wV%U&Yth{4s@&xCA3Um!pDHid`efT2{dwgYl&R)POMm)stglG~$cYv)e@(Z8uw_9pJ9'
    'AGP)2nqyWEdC+W+gb)|O(m8e3`mknevaLxgVDQ(hr1gWJRBJRgeyc}S?STV+y1&11?0E(9Dc)ykX@8-C`z@&D(`j!<m2hrh13|#?'
    'W_FOuqMUd@5O;R-Ti%GO)~J_O?Z%J*ZXa&Sw-j2Uf4uoxQX$%1b)Zy<$My^*(v#-&m7Ra&;Ig?nRu&TO#)(M2+M=IQM2Z5j_n=?C'
    'Y`IqlsKDv^370}sX$fuRakz)ULYg+cvF6S(tWWlVa6Lh*z4Ncj7Vbdf9S<Je(nZzAEs!cSW-CN2jzzI{t3h)aD@zkKr;X7Bt<eWQ'
    '5V}jCaW?6IFYyy04ZX%jUOHTvC&G2Ln;T7yB6MitO_v`xDk0u9&O^I$=*hN8v~3*QkW?BaDuLTTLSU=MIi(?lVb7na_+vjH0<)!2'
    'owP6xTCQ@`&i9LBl^hP>JmQbiE+K_-NHWVrtJMs-+JkS%#blD#<7Kf}36pGP#<6QmTG7n+?)RFE(9+bgyvehP6lFB4p3d%cMRJ;L'
    'U%`Q#J=`T}wX%g|=LbXE<F;j|_(-&zs8C5o2WTpRmAhE&&9%L$oXH(p^2eVL9bp;8eb488)0URu7zri0#J{6(WI2ptH!m!;O&CH8'
    'Ps>iQYpksCNthCeyP{@jwk51^y-Y)HuZ@$m*&}k3XK4%MLY=j|ZagPjC$3TL$z>zx$3aC+Up6K5XxSHZPHov2WfqBbCN0YAz$(H('
    'g@j_N8=foWpw#(g{a}duK~Az+kJ=i?Nl+0`bo%}cq)%ZRr8ZBpnNAnnaLugbS1WJ4#44MIp#)B3F{^L<%uQ%Fs@*(?w#iY7w!0=M'
    'B^Gu!SsYsojk2Um9VEDB>zr2PI+i(}UC8X!w0GS%loL26jQ|8G=p);^Cpl0-hTSo&Vt`z_MCQmj<F%supXy5?0~)2f^*7w0DYNJs'
    'an$m&HU-q1wl<w>roq8z$LgT&*?!wpIoodonr8cTQ^9P%z25lNS0`UOM^t5p+I~JY5FP^*><^F{+FgxOB0Eo&YS|b04RlSiDx>$m'
    '44O`x*?)SUxvULjM-9?KbEsa3GXX^{bc9Q4yd&6ke~V`X&{j<G?>O5vy{*}gh_jQE54?D7WWo<&y%Bf{`<_47(KU50zB+LAhFm4)'
    '+AgddC4ip=B4a;V-Qd^I!_s+LDAJ{R-qmh{Wj4;yPha_6sM)2f{NpO*I(qWc+mt;=UmU)9cX;%dx9RA~D1A9PeEIt5?I?Y7{Py_l'
    '`0ddPz3*DJ=XrC4oG~b>P3=)3?hW2BjX-gIpE&UW=Ch7!pLVgSVGV=_P|Fn6776Jt=yz|Bl9PLy#(~xeQe1B5z1DzEaC-+>M5-Gq'
    'gdwd4Q}jz)rMYqy>RMCKsK{$cQ{631H^n%)Ov6TSp-KUeX(u>I3J}Mal`k45F|><)8L@wR&`@gpu7K8w+NN1CTT@OyDmULq%VN9H'
    's+1a*lV-RfCR~DpVP~5NR+k7yB<>KR>Sw;*!KtnpU$#SToQA&JPYkj-#2P64@~$;?2)%9fp=%$xZGye67I7a5jQ@T0A)Fb6@;t;X'
    'F3;gE#s=zl6r&Sq80uud4I?#e)q1VOA-8S)_<UG%QupBwB(B#&0Ti_dNdR+VcDWKA43`&+mCc92x5`yWLqA#17j^eR0oe4Zgg(_$'
    '?uWlmr(4ZsbJGx5RL{1q4<ZqoG{aRoyGwOnys475;v=Ciqnb0tns1@6_#KcRO5m~{u-(spJ6qQ`{xEt|c|$SC<M8NBdi?$A=;Y_a'
    'v!mm;`jX}}DDCuKR}~kpRm_uKPG*?u0F9tAmA*6>q|%QJ{kjg^yHQoH03jpb8f%9RMlKIv25S~Eb~zR=q(fJs;Gwm*zv|RTjAk1U'
    'rn3r!4QKq#Rv%>421QNQb4jMnHdFFe*QdUVUP2*bzz*}xKi*{PdewB1lv<`vB`sTEMkj*L@CUXt1~kGiT^#z1&~9W|g0vQ11dlIf'
    'Z!!{QqU8I4Q<%=D)N-aDL<DvZuGW0`Kq>C{NtcXV<}G^k>sL)QAm?u9IFKV|9Z@6z_uJ$o3lah;3s_PZoF4t<=<Qh?nV)B)lQ+I&'
    'raI*3&<y=Uq&5F1RI(A{*TrZ<f2Y$W(DtD@t;#r6H-qmtWiQ%YGeqkpnJbCjk{`_BBwK*Qg)-fM<T@8g9VLwI`4q_Q<$NH_5XOy6'
    '>}@=S_k5cmWE4sMcQ@d*lP(MozyF%DhVg&ek{^7=Uf8-d&osW3Xs8&12aydn#DT<d0vB3(GJ0|R_Qlcb(aZGk72q{JIC%*_t^4jb'
    '5`YJD0PIK?q;2#nNZmH`k-c5FOfdkvLud1*=v-@5?$C)~iLyEp_zfSh>(~XT!$bDm7ZT;GtzzP5ZSm#}aCoAW$zq)tE@`Lja=9~S'
    'i;kE}dv%Dr)!Y>aXpWx`FjS&p#nn3L%j7c9930gW6guBhJJ}`scIRH0$*}S7{~^i$dL#)anLuU!*pF!SLW?C*Kd2q0^pZ|0?3Vn<'
    '7`~#$v2ztS(*SHrhU|wUyKKK1)s8i8gl~I6*`F7+ufsyAo(3C@ohn-dZDUGS^)!O1>$#?hF6>~XdDmq$)JB<Q0Grcbf2@f54M{k}'
    'WuQNXPJsG4?EKY?s#Rk}D%se$)jZZ>=W>;eF3H$|=i022-<f-AoGzhH$3`>xQi)bTrE;%|ubODkYVeQ=x7!c`Gqm&FY+ET8Yt~Mu'
    '#9C}R=EOhJvo7iw$Vb)Gu<`xoltx82wU4B>!AL>0%TPhIbH5ncrBw_qZd5sQ3tX!#<+@IaWQ}&cptd+9QztoCbvDhd@Nbo%a6>IM'
    '`06#+U2`2d0vC`@alCu>^9FM-S&?@i!Ooo=w>jF#!gbW81%WvSRfiMMJ8Y{0M<ds(V~}f0eWVKkt3-v9;+p&eJtJYWSko8L=?$hP'
    '#yDgvT%JlFV7?B@tV=;uKrrPSQulxoAg*qT<)pvJma99ldSNJkI(qeL^y2Ik5BIuU+zl|hKGJ#FRMbHJFgh8D*<9~}cl_i-OgLke'
    'd8JsTXqd-~-w6=-`SA78OS-?&AII|rdY|77Bk9)dox{(|rfXGuHdlae-V#1WSr>R0TizobYU!!tDOwuv_0sZE=ttXEv)i^;4iRi='
    '<7dQZ{fZ9TX=%Y>HZ3oiplx!*6~7Dgr-G->H4NCL5Dm_T^NI+HT=c1AgK%2A@1*$(t5gY+d#$Zk)Y!>R=Qeg;QRC2k=yVA*ppLwz'
    'zrwe}{hIHsZYTLaRO*~Y7xj*stJ@1J>f*%?K$%n3HVGAzpW3H~iAad^@y@S~%h9Zl{|V%S+^@t@LzXu)oT7qcBKwdsd0_v7c>z7E'
    'g%I9Y<q~jx2wst=ROZyP<3X@&4HXTEb=_r?W0>w+l~_;ouujG{B<K3uRzg2^RGPr)Syp$N|HPu*6jdLXho;p3vYhUlQ>AZ9yKZF+'
    '-7R^#T~5yST*UP6R+{{l{Ff?glwS)wm@29zk!v6u?)Kd5?Nu_3@B=r-71q$TchR{a+f>MyherY$B{e1|d_;e0Og>_v-g8O?Qs=O*'
    '&|r2aiAiL9YsC2)u6s&Pe48&xcqX5hJX_8RtW%({vr{YE9>xyo$b$6>j$b~ovltolZxphj!?qz&Y!l*6&G?E^kC?DVJDs=PD1hG~'
    'jOOV|itkF&kT~WN$8u&4D)~n7Ikj<d=j5Ejho#z9Q<KrQB-yr#u@Ja-O0T^kM{gh}^iKJ*1DUb~wmSc@6{6C57M^?AkG*u+05Bdk'
    'c2=)eYLWIt|7D|;D*^NDrL=l`u3<jeDheWi8=7*n>t;)CVnsI}BdYv6P=#@xtT2P{PDAc70&ds~5vsjQoiaJ_-`>hO&6oJYm6dSO'
    '(i$hyMOqTgig^K2FH8@;p{VH!^KUmslgzS6PUM)eS3gma7@wD1AefqrsW1wV86`AO+OL5p&P&=ype*Zo_kfu16b~DodhxndtLu~d'
    'E#}?yH(0Glo%*TO>63h7xc_W&Z&LuLYn!v1gP7(+9C=3T)=GhZJg+7((5@2RuvI;vr14{e_3lU9OydCyzjt;NX|eM2$^o#LCp2zq'
    'b+qlVXi~4;)dS29dwwwFAdGWm(z8p}Hare>w<nju<az-RxoTB6@YIIZtJz&kKF8gZY?dOO)Oghuf*BRo`G+*^LZhD31Wl?={yh#d'
    '_1dggAT$)es@u_cah^NLKmU4kGD;7BI{Tq9!WGA;ZS45{;pwQ+aaL7}D-IOd*!lJG@w@L2U;L<DfDi05AkN9lkXhGKc{lTNF9$*{'
    'QbY@-!R`6_Sjl>kEo=G);0FCYI9y)CR+X!F^rmYCTqS8bsm9vDvR+?N{wHiU$R?8%9`LUkd#w_x)>tS+XJ*jm3E&<=R+tFP6^+2%'
    'sazYq(&tKkQ=?2Kh{4)Qn87^C_!<6SLMV}!lg5{0ios3ZnG89tBd<%$z|*&s(;Ge_2`m!y4BGh%3seLBOTUnRT;S6Gm7lN*N`F4A'
    'm4LqyPnzAtve73C$OHQp^XxkRte&ij{w>RuGKngzaO-yTOjrw=JyLyW8|OwfaRN@PSRJD$G8Dbfnytt(Q8@-Ac_*uOYIeC3YA%%I'
    'Qsr0K1TkxDLhIl+wo0@Jo*>qhZyLSX$qG<<NVjY~DF|@>HjDl^v<!IF*Gd$(`2!cz+Di`~?gtcr)oP8o@tZz}oj9!@IJLG;%Y0su'
    ';`2ehC?R@VC#m}$SdFR>-{&UAenLN+pW%G%;jd_oSm;CgrT&Cbpgjz3t^MFnia{>%k3?V0C!;rqn44S`r4x}MFh|zF^*wDB|7=du'
    'qC&xqYU!qBCbBTyR0U9r<UFWTyL{NlTMj5f#V{W9AM9T%{|n%`)^ph2E@gW(#%XLb$i_y@^T6ci0oqc%nub#q?2Q&oC0Pz?zdVH@'
    '4dH4Hf2-zjyD|LtFo-*B?W@;+PY>T6rDw-Kj^0vA8mB0Uom|#;(`?lg+rX7y0ljgUr44PhL+pl|Jp*>okK@mj2WzIK*Vbj41*^wp'
    '4NMZ{2T{7Xq0kQ}GTO2}iz)?e_n|p?X5N~G0Fn~xX1HQ~K0Hw3CSL59!$3aRT3M>Sqz3`5uS0o|JCOmj*}OjI{|q=GyVIUD4Ky2-'
    '0j@24+{--{xrcOX>V30#Eo;~Hjp!JwvaV)%6BNAKNBtM}!eY@FEX5k7b=8#5{q*z)<-nsY4-KWlqN)p#W_{4S5SWDa<XrVbhvqi('
    'k>Au-ZOt}<p`NZ5O&Cz1vkYbhJLe^k7SwF9ExisU##LWq%-&<=KPtji8pv$9QrWuLN1&<Z^|oSfFhCm#>qTXBH%G9Q0Sp=&GY~or'
    '%&Kel86Z^&CzEN(qt1~XKjV-i^mBpX(5Hh+!T^Jk_f@J>O^)oO>ywDqL+7=A&goieDoV^|j7jclngTg%Lldx!S^7h~mL@Z!_D=5@'
    '@00Hz$zeID2)tTjK869!wX0ysSr-8zuYmGj?0Z?yHj}ajCpQdK=81ytCnCQz91`(}CG;WuEB0OfO{`%v)OYmr(de(Em+A4l(aGW2'
    '@kx4m{L{&cQF=0Z)zk-jrB{+&B8UI;`1|ze<%Y3Lv84pV&~_Q~?D*{PHI97BM|9r{f^)_f9qi77AD*3!-n={Gkq`Xvy4G?p4bQ@c'
    'wl%0I^J?>)jQ+o$MyTHRY5c?b>*_w2aWFi=y#m5sjV3a1fAf)SNu1W=|7fQkQfd*qe9D$+R&#z#zzpAc+M`m{yHJjm+cKN;A`c#L'
    'gdMTB5lGp%f;O^D%CF%8pI6F*&)|gq$64n<h>Rm8SS)qhv9r8jn3<L<zD3&55Jdfk?L|D?zHsFy-Z#F<YRzoiYVyZQf*Z)JT9&9s'
    'h8>tAY_-Y6Om;(Fz|9C^v}7%JOTZXHgIMv;mRS?MgF|^Dyxo;LTpm|Uy<^)!jqE9S`Jo>L{0vHx3Zb>ny2uwobM0TMCf17E$R*ix'
    'oOAh&<HznF+aRY+xpQbLVkvFC>UF&cR*D9$0TDhpoPN13WAByLH2W`@9{NwMd)<E}`qxwmnBHsF{HGRK4o!!(_uE>D2EL_P&w>p)'
    '3ZPC}(i<pg%sf*~-5OXNVr%8IaJJHZ>xZ$ohOoCpmLTIxVd>Tvf>GYhaCEyzFB~l*C9x9B!>OH}ol04uPg#D|iSnp!B?~<(^#7s+'
    '%vB*VOcm0UB2rUL71$PgQNqdH$^Z4yFnaXGANJPua__1r_kb8gi@ViLRX)8arJ9hK+a)`W_R+PSdf`N)@sRm`<lJWkG`+eb!#%r*'
    'lM|d(>&UAoL`6&`O~<UbQf6d%0=FrEY^i%;j&}Wnh%66)+imrJM;Um$>^sfOJ5JUe`LSN3XWB(c&cvenN=bc^rafH>rZ-^i7Pd^a'
    'Yja}!fd`9f(RDqDVRMj(qVuHcajv|8FE2_%Qr!lYFEF&?0+IH6GKgS*?V95cV7UZCJH8sdHp(j)-mBs=ZUgNZjC06t{nzaF3-274'
    'C9jd^Bn+*60^xONdJNOowSRD95|-yMv}DgauaR;dhW8Tt;J#P>!<Tkpuz)vhx1}oBs0M~AkA65id)I-ErzF@SI!i*x=mUDU;PLoy'
    'Q=#jU89HM6>lOy%2{heu+rED&$vG87xforo9rNh(b~P|A%XPJ$03Wb*2Fh8e?dxYZ6cd7h$IA%B^$+<H1$ovEh^Hvp3eo2t`TBq}'
    'k@anrup&*#M?dX?TsFlpX3Uu@#k)DSIG73r=n-(l7)&VL;i?j4S{(te6Mf>5?xRmI)V=n8;(6i@VoE+7{@$-3Ivq%I;Y23jy;UBO'
    'iJF&+jX0*ta1m;i`s6PqP(ohTNjj!MMAdbGDy%AmEb>4Kp3iYW%t>|^Re(@S6|{-`6Y>mb=aaJLtg8I#<3|G69sUfsYQ8-dx9;@x'
    '?C=akPz<*K`ub~LVk*H;&z}7GzSl$wkv-gF@R6!iUu&l=<P(i%b1_?!Zz@Z7jIo^B7mooiiTqM&q1#b{L<ix?6O;!WJir}cVF~{2'
    'Jy!{Z-Q2PCs>Nd(*+})utA}Z@15Y0hyzjlD#ip1-j^3FiiAT&vB+ov0SzDZmw#!3yGcna{FwewMyZ@TAy2pvH#clCab*8x&VJWq)'
    'GgNQzE8MZO?z0|6NI8WK;s+%yV!$N=zi=Dk4iU2L#j@6QB2W*vQI!S~Q;9%SiMUC+m`mFi4BNS(Xp@~!J#ll=z?0zM0k2PkVdP>J'
    'KrdWN!m+qQFOsMGaU>b0<;|DMkIT)+s{BLiYWzN5ss7QV${871hdfypi~baA3G<kH@JX!E8jXM+v(CpJPF-G<5xf*qfF4^+0O7n}'
    '0Ux%8D@7&RiHX4JlB*FW?6aNEUFOcsSlM!f$SN!`8bYXaYI)T>DDK+sj2`0S1P1u8XK*jwU<vX@r{M7no=3wpHPTd*li^TPK6FBC'
    '*qK!7`C$}1D=HKHFlrtYl`MNmsMEAyF%nQISpKuoL}xD_DwIH@$tOF>^}Xkky2-;+hv@b;c4{f>gPGgi+6BWXblh}7Lu|l**)?j3'
    'ZKxJ`xiL*burd%l|9C}pPZt>LsY)wwAp3NdUDrdr@(7FJ(z|$6VZG}CeavbUNBh;+4vzG6n6z&eX*#&emBQ0)u~E6&MulIti|00n'
    '&JD_E=e9u21COD{4v;NPu{61opzXTn$5N2byXISmp&V4isu5GiMM}+~REe9Ni>VicAI}lfmrDebF4>_zz{Pm9QLlm7Rwa_24vH9V'
    '%&QmH1F8?6?_c&>jDW>d4Izp^Rg!~h#y2^_VS7GEHs^VQg0o}tCA;v4en^vyNSb#UsunkO2^!qN72F1=b00dG%J-te*P$H;jQ@8;'
    '8cr0?Q83u!0yhkLmFn9BD<CbyUyAvqI^j-)Ukk6~T^F0HjNw1KQ?A7g72?1$6r5JSPh;bR`&wR5?o9n@eOHd%vc}HMBcU+X1ygi`'
    '8MmAoCv7dH=1J>&Db3(pN`+T3?exXtH&v{Rm7i5zK$qc!-^+y7Ccna9pbcznnOoV-j+)TIizaQ1be~D!h7JD4ut?2UCN4w#;iV-;'
    '(tBHXjwbW`V?O2*^@u%vvd(UevRAc7NcAUC_QnQ8{mo6`Lq0EWleP?E3eTWTfa?u~NF)X~?dXafdSje~>5csT4xLnd1Sy?ScdZ9d'
    '5f;tpIN!>BlaJqrvKT2uSIqTer<@Z@Ea=~mSiAai^z+-FUcYX(1LR2<fkFu>Ip+v#>o-dZU%J9Vn{1%CJ1URUTApTT3FG%#u4UPr'
    'Wb9A(9@j3nY+`O%%$%irSqUtR?g?Qhl}DA<p=smVkG|DX%(qGObl)0EaonOUL&Zul$#qI9ruVyq5HqxJ%FT690@B|lEv0-#CU0vR'
    'o&1!29w6dy>s>QvlKYq0CA{(ctf`M9gRut)S62bjn6IM_(i%xgpsGs3+OE7C+z<I%L}c4(YU0z@MAKNoXZ}wwpr_FZ8RVSM=t>;z'
    'IT@u8$n12l^TPHU&}umJs$Snk`|OV=&UgYPrBAlEb)s`NxHj|6=!84jf>Og!0IyPUHpBD{VCO~IeX<{$#rM2$b<P4xPKFB@7I>xw'
    '{;!(N(7=WY^BRj|As1z@@Iz5fst=7?PG7LP_9};SSP!B%E>_nO8lrG0G!c;M*9thTWv^#<&+P%Rc{a<Ib3WB|L|oW<!6?LTZ{*~R'
    '`G`UOLWW6(CFY1441DR(EG6ZobVDffd9dDqTs@7@;(l#0BYYlr&<)x8phh8Dp<^7mqe{q`SZL0x3?n+ui@G=*wB%Dy#t0MP9MrFD'
    'Md;m-`HKjx71|79e{@AA6T-dOBzp2y%^bYYq(O9eTiN+5c(huQaznpNUlGe3WfOjy11~mbmMR+03XFTkTD3|#aE2pn5npqJiNclu'
    'jeYV}FDT6JP6eOrw-Z3mUH>-@t1<6Cd;_mSM@}Lli0Gyg(b_kWJ8aDLuaaO~eJBfwQ>CyeT>aL9el6Fj7#-A#cC2Ek4_ml?p($G!'
    '`<E$yFazpSu9~(iH65=$V8dJyK)!>ozS@*C;jYMM)<J3JJ2mPado!&<lH2!8<Je{flX=UKIm0yp;r}(TlL)0gjt<?9tt_T^-(|Hi'
    'iqe&lhd`&jT*!q>Qn<pN7uayA@_-+m9lfCxz=yA;he``;_c57YC0Y34>ytNjVmPjX$T0|n$3W_e3PdgEY8BN5-+5$pwCFA)0Nyla'
    '-D-7@b&ba!yIAoLX52MPVy1&*eW!YdSesUs#;SrrhU)H@=&a+=2+~2B9qG!3sJ@M4xfaM`8MWs&-LNS!!KJU(5=@@y9Ra+&{A2W8'
    'g5w08<3lS6pQN3pYpaGggThTAEHhVI+meBJ<EQ7@$L{`MAOAUs4U+Vu=AC8$YNzVjfp?PIsr94={5T$ne>|1I#r)8zG(9>RM4Nb_'
    ';P;(`aO^ir_phB$-jUD`_PyF?EW>a{C-S(~FmQ53?ctY<F)tgF5?vA&wbwoi=I10NmI;w^8Py~)SMBJD`OdD#p_}3>Pbz=1?<CAD'
    '*ptXC!rnox6m<O<Cno=0yWpzBe>ogLa%?45R-~>Cb0-;+WJkNfxEbW4{uhaaR=N(jKeE+I5_McW@`YQxUy0ujR(e$9bY0<>vJ|OL'
    '&@IrG*KJ3Ek)4klMOhNd{0jmEdadmM5?_|+wiJByD!+RB>=mLVA6lz)Y%u*?XqcA5wk_jH8nK?pSvqrA99cQVdd*=heDy|D_)1)-'
    'QzAC?tLU~!sA@p#q~lK2vpipPaa;EX2SWZg%cwo4?xUSe6R|U$W}+k4j^n|UjK|X{SKgTw*Tq#a!{`!Ga_DFi3AB$!<Y~me0HKdw'
    'V#{f<td-JicBey89BQY$R#mdW=^A4wYDERlNaB1~RkIOk(W|A^O-rY$_2^bSNu6BuaJ=Y6x7XrK?V45}klyiOo<HMRRnu%d8wUZU'
    '@0#It6a#k(*)Gv$GU1?5cR2w=9*^QAyON~3R+OfiLAW>q%ms7s{(*z_jE8nWVrFNMOdSpAW-=wmZ13PIp@z6FW?301Uh0=BK;?I!'
    'aP*LZwYYrn2e<y7<4k_<E?*kcO#P;zXs*DQDKVN%&RQBR2Sp!Je`Jx$_5DVNG6yppTbrQ<Jr8{JvSo{`ZIYN*By{A)n>yr?h#Wt6'
    'vJ&ze;wW{R>y0tCDw?fri%lB;jm2@5E+ix3XWLKMkq>JY4%?GdZY;I_uw<2zqdVD9?vwqR8|ENbB-Q1?qH|QA!mpILV{u9=x#Z>&'
    '=|sv%Ph#5Y-_547-x359tnuL%wUi+nl`b~~((X{SvlmEOX{u%wbxK9J<H(7Rq#TBI%^7@GAjz#4mL0=O?AnOyv#vbM#^?JPnS{Fm'
    'c>CDjl7x3720l13uOj`QlN}ccv`Gic=xm%Q183Rt_3u*g2Kj8St^Nx!?Tb4YGhg5z!ThCdol&%v3|Gx{obwtm2&#PvZ6gy4h=Jpm'
    'Y#|-b$s-RvWRQPi(pHot65Y9XK_gQw9e$+`7smIqGP}~BA%~$7%N^7U%tE2Q$6pUu&f<4yd@vPu82j}wJ|(mH@?hrOtqxHw5zOiz'
    'Jt`dGzM6%pz@tasP<t2n=>W5`d0e_@Ebwg}p1i`;fT~MBM<NoK>V`VOCXcR7mpDgsGlA~z^?cpT#A>EGw3um|c7bU>o8fWzT=&IP'
    '50F*^5yn{=ffG9VeAW^<ayx&;t$!)UD2$3tQs07n;V%VIBDT?C_Y55my<d2*gE>H)IksR~y!$B+L7o$fZcdo&7;MChPLzzukPs$~'
    'L^}|+`hBrTXW6=JCojDg_CGv3OoHoa1GZkB_Hnk%HP%pGW_q;Xv=0IOwrC5swWce!1!nCdxr#35vP3X6Z;iNZgKfk;eDPyAozaH<'
    'F}%nI?PuG*wk=#VG65uVC+umHC>0Ov>eZ}yvh;Pl;f`=`wBAlBI9hYbw<v-9?F;ccxO|?A6DJzvnC)H6)yR7^7b6{Q%m1!5hb?}7'
    '&4R3!5U^9i`qthLN@O3b5NhPhq@B?V);89NlxzrG+F90er9Qd$TH1Uj%&fYJpAE1r#Q?%rrPj7t?z8kDSV};@RpR#-Vpkz!W=(93'
    'M7)-_)q4|~o_}1-igB?Lua9aO^)c5lxpIpq#)k^QijIp-Z656U$5a|52VX0joG1aY=DHYxst+~Vr)Lx8v?~SK`F|mEp*4tnU{J5G'
    '<^}5e*cBN^?d_m8x@@S8Vi_Gf{aP%#Ege;}M#8gj$OtY{6^`bP19pMx_O`@egi821K4MfH(^kjSKpoMjkkx2ngm)NQE$Z7rbj(q('
    'WIl>RLt+X#oF`x}AciD1u#PACL*BtnT+C)POnsxAIWW1VUvoghFRJARg0_Qh1aFg6EkY?}y~3#U+bWC74anD+U+r{-(n;H>fWp{J'
    '^o^fQI32PduST91IxbUIANUfEpm3tK5uXUv%w9*RDy@Yhh8-tf+{JT);)2C~vOh*q9;3T!U0!__Z`P{`$WvWpLS(aes8l{@vz#D0'
    'Agh2UB<!PrK`+=!hy&Tm9Cp8~tk^??rbKwL#)f7;RLUB{Lv10ka+TmD%(QTWhRxcE_*j{&?GLhk;zoNixWt>)rfve4W??{9jkYCx'
    '3fgi`ftz6>PO&w@0a~em*i}!t*NL8b?`P5{?oq+Tnz9r+#+!dxC9D=TTQC_>uy$6krA>t&UMVZ6(0ibAE=l|nYN5K4Z7dMoE_4hy'
    'gSxUR*g4yGbvi$vYjrWAB%b#<9`z0Ds@AY+xT^EZ9_Is9E3nnh%`~hg#g@4Bg_zuiSzJ}{aE)cSZp;|nw;Ba2Nm;L3)LfQLDI{Q+'
    '0d^ECfX;Q*n2u4zuA@fJoO+gzltHFpp-~$U%$;O|)qo{nX4z1@s2MlP9Hd!#NaN&arnLlR8Ju>i$Yq2(Yk#q8zok5weA+8;HEfA)'
    'bZLJ!zbdZR)w&ix!PB$jcfQgt7KUgEd`-4$2&2t9SUXnzlFGe_IxAKwUmvktN@VGA*iBQVSf{VEV^{)|{pc@eqmwsOqCh-AE*>51'
    '*G+M_jnMJvcn$wMo3UgE|7fp}3-7iG|2V=Qjf<3Pgqd<Z(9ff@)O+W$Z%uy<)xW8&*iD6FkD)1|+g(52K>0N5p-<|%v{;WYAyi2a'
    'n^Z8EB++$^RPS0&%3_({78T{)2~a=Pdq>iz2BY*=RQteW=?)M|1nCU#Kix}LZ*>SK!Tt9pn+kdcx(}h57DGm}vrECXml#x^ig(Jm'
    'x5>_|lRz>(3A|-cCN#TN9ZuqxQxED674xJ(7P1*zR_JZbD&UA`MMj=P1@O@qkA8Z4GCDne9kQ1P(hIwA_tNvB*1f7RBBW0_$SQQf'
    '-YGlZacQ&|m{JPM<)QZ9j2M{_;nt|gVoe_2I=&^(mJ`YVg(>>#n_{8aWbsT=<ve0eaueTVHKy5%@$AJ_9WUWfRP%V5$4uB`q<68E'
    'sD)GO?U>`QJ(HixHx){Lw#e$*v|!f%ZMAxZL0io<WvaE5G|VY@!(`*yqYNPwnxpb=RnsWLAhPHtL&Ka&Z^oAU7;qDX4;+%>&9WI*'
    'J}+vylJm)PPVB{>diLbcnBt1#8?e=^c%OeLC}A5nS85DSs2=0ECT|u9TAa$uPWvUP$S|>&A)puK*~#JC)1%SbGjzaysS`LPZbGm4'
    'E0Arz+J6H7dkX)1h7l6fUQ%bDCSM!jEyLWPtL0rf$!FPJSMrV3v1Cf(0+5ab_n(NBm;>%f|GOvqQ5|6<bTtKmPjqw0$e`>-BeKh5'
    'nOmhE0ix4l75(xH4gSk7uG8^UEnXP8mNlcANKN*;#97`@&Zo&aK{H7hwFm36z!VYP!B_D??@Mt~ee&g(YBcwd^CB>Z3jXo<$^N&T'
    '<IPGF#-QW`zbOZab*WJ-`n|-&bBPd)4BrGWC7-V7HUVVpGxUJ@AwR;B!jLIqk-c9jw_sn=2rHjU2XxxcHrXZk<b40qE!7QxP_veC'
    'q;6Z@ql_ZTQ<+vyEe#g2-YsSNOG*GOiN(383NHB!i4V(4@jVBe;Io6Wf1l8UKmkHt!O4i>9KlJcaSL)<K0xf3UtnCs9Z?fwJI=dT'
    'tE0$K*LkV?|MH7~HwBmj!mr?3`Q;b+5Q6%qs#gkQ@TCqVte+DO7js~e3RGLtG{pxsGZO=Oxv1@ohpqnN>ULZd-45)2C+_Sq$m+e$'
    'V-389lakc9=4|kh=I4kv=@gSrFG&pKJE-EKx(^N30!x+SW~!NYT)ArVcZdb<^Z;Qx5+IpMttD87{FTF8LJ{PTpL~~KWQ<^)@LM52'
    '<0m~Gn}JJbk3N7;4Ofe<P&zd=G=>d%OEtEs9pzRsSI6pxN~!VFfyzPF?LFrxE3_S`1hKHJLPbv|38iT2EN<><${<6fG*oD7$1bB@'
    ')r0ATvN~0@mE8$`9H%EQkKexj`#<ULx5uxJU%x*7tNQi!``5=We(c4a<yD7LKEe0%Y;I==DW?_Ic$ngTbouoFCsJ13o~!_04NlXe'
    ')05F(y4Yb*uP9wH8xz%&H3(KX6l^d2+3jhU6}!tHsi2k9uP%PgzfBIl{_<e|$us&Fz(lgm5(^RrjO}X4)26MlM}2&tw~hE%0vc;0'
    'RX9%eA?aF4q!~dl%~J}@xhQQPcP=gfxphsD9XIB$CuU<_0J%KlKSzIi@!H+3n6q=iQFC`mmc?aBFdyJ^wLi0UeFOMK`*v538~Y~e'
    'YO3C$XC=9bn^^Pm=w$Tb?D*vGR-l?5dOGn!%is+ucKHoM_o`ST{+qa5j?6$41wI54P)Idr`1##I+)<G^!g{_tdf72bXgW-tJ!BU5'
    'FcOoj$(^8w7ws3HzNz&11fRH9U5Gb9Zn6u1*T5D7<>^HoxU|m?E(iR;r;n`k-oN}q()ll<MVXps0QEZfP0qwL>^yd6epm0k&zEIB'
    '+he9-?+Tdh6zQuoEhGsGplKcG&!0Z{vwN#r>02llOv+ivyXT!n4HN7yIx$*&5Yq6gf=4r&P|~@K@gpq4D22vX`jf38t-@w?Yi2QG'
    'ty@afAWl9P5QTQ)7M@G+V6rVn^*K*J9QULhZQ--9i9jn<)T$Gr+JRAc`V>Q?mV%x3FOeDHzlaf$mwp)Or28eO(YG;<Eo@ri=oo1#'
    '^7twnTd3Ed3CG40IwX2|`<J2XkJ0U0SxV4=v_n*@tP#MpLzt#O$RZFFzxq5FfhF@(An#BFRs&9*-xRXCZ{{6bT`*3SAvWA)e2hy{'
    'QK{Um-?C1LPa^i6GfJ)Q_!dCnI;Mmse2-Xnj^QGnXNje<LMm^ec_zFP=}?d_>uggJ^z|J2w+9{8PVpdEW#a>$3!uh09s3>TDghis'
    ')>XfcJK7t9Uprf<zS6jsdEV!pY_aHE!i3B0w&(-*TEj8z&(<ING<liXd1sklBQ9XeBAe*Pw{yC{>A9riL$z4{n~%E5JfBw}a?Xn@'
    'Z1wcXpT7P^z0xcz4U%3{izi=w9e1Y1M|M(D3jx9!<Su9#T-W8i!}K=QDatyRJ@oiAoF096Q)|9@TiC$u9W5r28;R91JZ-vnalGZV'
    'Di4y9tOWyFSMkBONw^U(V}SQDKsc+{OY)|;&Pr8=Uez6B5q84_6lz_~khwQ7PwQE=f{SavXU}FIX0yG=x8WHZhC({qTg;t90J?>n'
    'V_JaB39=pF<RwZY7<_ES9tT=|%NG;=OLm^<HD@kT<eK01gWaDJvj@Zj&lGC=$>&9#C}*b3SivY`kdDjsA|-}6g{vNBn<R}F)E?oX'
    '3RFe%UO4IbTIc?U4ZO{rkJ<jH=g8QsIN(#6tzq05aA3WL^Qzrg1W>0fCOK^xvG-l_%%U{9iMYLm@yn@d+tEdBpY7jwV)%}D_5mXR'
    '<Ky5M$S$QJmXgS>F=jiHbqyE>eANr)vXH2wK$YM2Ne2qAei$9Tv{^09V9^HIvx#kXL1u)#l|<bMRXp!3*Ja<L`xddkMj1Np?4UVz'
    'TUkR$4QpuOa5)m}n`{M3zpVPpd@;kqkku7tcdeVys&A?fjjaKWm(%8;wgOjs>2u=LeXk>}I(yhinCGjzRbC^6)l5U6rA7+2!-&7)'
    '>ED&|dcY2ioTmLI|2QeG(YB}Wb}IEk^??2*vOh2q#gt3j{SNZKNc<szpThtiB=U0?SLip-TE%|18w>tMvTt25`H3aouGnF2qzSv4'
    'Rpa-=#FqRI_Md(8)t|oZ4Q~b<-O!~*zVUY3(yirA^4r+_D$2_Gg`9=;bB+W*Eo<1>E?fGfzy5*U^$+T;f9cL~M}x(q2!gIRA=FfX'
    'rGyh%%&+4K06JgB#P+3S{=wlv#YdR%6ETb&2pL`Rug9H1=P{21e_|e_j_psz?#lYcQog{>hw+X|WDfF#E~kXAG=9`GLO;*Q$oRAu'
    'HfM}mtYUeRgcUXRnKw7-4BMIreUJq0B5ur}DyYOA?Kz_dus!^J>?A#sxK=B_Hr|E2yrp_jbr-ilC9@qGg08H+9T2ojqLOIz$jgaC'
    'c~vek5Hf*Y>Onh~=g|N1xfUKwJGfXgy!3tQxrMMLi9G~2q8mzl$#e!hv@%*W6s^~mt~Fc2!B6yp_qu9;J~ajOQ7P?VoK7PxeuJ>_'
    'fWJk9_WLN%M506cDQqZOBbt)j7tx^(wL*}KXSwLfsgMQc5=34lLT)G;XUk=Q)lA7uC!BPrR-;KsDs6bw{Xb9k_oE-bk8)_%d(QB>'
    'S(lR~eQ1isLZ~PZl|il})Gm?LXQhUNt9qH0+WupyCWuCh8#PMjON(Ewqim&;S`LiAx?^Qf{M*0R>p2{TyJQ7W=?DR}I74!DCq58F'
    'FNA_ZE?oyP%#1ylpWe<+7n3?U2Si8Cnf%_#MIPpN$+Jct723eDz`xK8ioamqlQr_Dcx5TcM^9dj{YCVn3qWOcC(|_=KeQ-Sm)Qci'
    'q1BMKRne##4e@iN5^6v!#r0$VK*=*T7c$|!QqRaMy|Pm_Wy@KCY39pZr5IIhcM+~yL`df9pvSuOBuE7_El9deAM1&VBo%0Kpc}PG'
    'qj9IKqOd5cfJPuTE9&Spdgxk0)Di_H$@0RbbAg^JviUqjExD+!OD}_i7{cjHP3M&1%A($FE(K;*ty0mqiNe6xG_X!hm^(mpR+LMb'
    'QDf!`fPQh^V79ff0#}#=&j0A@bdCOlINOa%ian!nkzAJp<2r&@c*nLPs_fV-mKjBo8BwtsiGTgmRBRC5o-5thrK=mW1ROIrJt?gk'
    'yVZIsrLj_vZ9%0W#_2|$cIm^i0s?F;ReiAIO<J2*JD1|2&>}-yn{S3?XO@mh!PwB0KR)<oe}mn)8L+e2lI%>_)@pM+hU;7t%r#@7'
    'o{bBE#CnX3osg@ZzshehS@`DB<eUC*UM8x8nA1=}<9;yxlo$U7_v|{~Wa}2EKz+8t8M1C;x1vcShbs*lBeUHLtW)Q`C8f?)P9?F3'
    'x^}kZNMp#6UVan!>~XGO58pe?Y^+3Y#NTuB9Ed$siMt&XC+Io-L61b|8(ZpMe5_7W3}*>{!$Dr&p=(DcCZ_9hXt^(FM@m}*&{&HK'
    'CU*H&4SwY~AXYEn#!-<rohqtn3UI)|P?S-Lgvk~POLOMCMZ`o_!>`aO#87)O2-<kVjnBnFg6JB11jC^OfyLS|weRd_f(128c8$7g'
    'YCD}NtXEYktIbQ)6~Pp64!}ar;*LrU!7U=Vh*s7S0%TV+42^R+Y^$_o-xAzuU^&Nk2+g|;)5JxiIPf94t=#lD-Ojt8Hqx$G39g%m'
    'W2+y_=R0k)Em>+e-!Pm3%=9hei@hB$Y|NHjnH22INuDdh5j!&KCb+8(0(qK+@s!B38A?2GF;mrb?<CBNNsLE1rlQ`v9gN=dc~E?S'
    '{h4e3Bu*D!D3_6_g*6f+4=RAaiJv~X@8A?|wrNj08yIDQ@i*YlvRsfP_<c$_s_0dckRDc^8EchAyVOgT-jF9G&|oY2gWh-kgBitP'
    '2bRX5vy~U>{!kuPig5X}G~Xbp55K`lF&69eeF2<+Z7u7>@VHLCiIu7Bip^xb(5GQ~i@fn&4wFipFY~jGB{%UCAjMp~jDMc*U#hc*'
    '({vA_-;P;vpmlqz`C?D0wap|gqKBQr@Yzac&HipBhw7NN%z}r<(1$%akp7G~yp?xHeBiemZygRbZYbFFnUqB(b8(SOcs;RY_~ahG'
    '4#;rPwrJBrH^R0ApS9O<yi7jC-n4;&SR_M$<n#FtokPzx4&j(>g24`OS4BW*6n_us?90NOhCb-A;cn1(P)yIn7xCCmlkW;FG3&UL'
    '-hq=EaECRTrq*eKMr!Tylt>@mvRX$YJ++cYB_U#Wsy-KRm08bh;}<F7@Rng9;eB8xAqr8QH<Fg4?K1`*Y7kU)vTC{`^HDnA+K2KS'
    'gYm<wdVXuYQ*=#UJ>>4XZD|%1`p|ZSa%ZP!6&ga>0EvCf*98E2=@fk<uF6r#T8Kf;x;ZLmVT8vWhX?EVj&)%@zdqP><9IVktVuZ{'
    'k{|0BRPd{$QCh*zBDL1hYbR-Ls8#z+tUcCK0vuUQuNor1CK+s57rC7?F)^YorL-OGK8isdD~=1<c9Ma#+@tPNfq@@U8#q_`UFha+'
    ')y<oEJ1*CMNG$(q39SH((qD_c`YK9eKyYHW_$H_xcmDl-F`J1ZIGEq#rB*(-r}q$FY?XbSnjzpkFS$-E$||q;XRx9x$M&dwV&0yV'
    'zX-POv;9CI{dSya;sxP^B_;n4BE|z9^+QOK*hu0p%Tk{lsOt&CuN%(u_N4UD70Ky2Mon>aljh<!YN71&=;~WG$edyRL4r+e$<xZl'
    'f+CK|MSE+0@n8jIZ0a0-e>!>#b5tFfuyVX$&owzJO+!dB@^u<J3xX0|;%T@FxgXRG72mptIdG6eAb!BH{f$R<!*La$1tWuCQyNN7'
    'H+t&eoBduJ!hCKp%Ks#yH5Wm?%lu5Mi*`ZB<}tOgYU3$&c>Gj%+l|{-5vmwvMe&jVtvgG5HJepqRn8B~oK+D?R7kndS54X9oVX}$'
    'E_}GqU=pQvQ0D<NK>t@U<O-uGE7j~FyG?{YC7hL5Ky1EBaq#dtR2j8-H8i~-tN_8ybi}pfs4v;<$`1Y;E?=i9h{f9lEdiLPDDXkQ'
    '5};nb%i6K=pvl<D*qmUL{H!dft6E;H84bW%^PAK)6geVXa+m>4SxOUoHfKWIE+(mlzeN;epeReTHfOs~VH5F@b~7NigCYAFpbe1x'
    '4DNg{1La=eIu@{DIaA&Q_6Ll)(efmqXkCh26j=@*$|iouY8}Tph)&rzfM-<Am0yDG>Y$>eMXN&|hFl@jO7Eo8yva&xPU1D24Pn{}'
    'QdnHk9-nnf@VHRH-*CETFfJO_jrJz$!c9<cO-F(;I#jTmp%qv0+ua{@nh5LdoGm*#SrKL8LOxFXZrXh$lqATD?9O{C5;80Ax*z#U'
    'lhfPtHE;O2kHnD9xuN1YtEI~Cq%?f-xs%jIF(!$MAhmh~nHDEAo60wKJ~uuXdfDUv#v>6+46{~;iPf-F64?$=RUf=`I9c`7rb7&R'
    '^+F_XGohjRQ>C0!jU8yOvSJ3a-yj&!im2L@HT<PV1rZ0FmHxqBsdAsxo9jU8@%e<L3i^!9iXzMHC8O7~IvCci%2Y67jMrI&o|DFZ'
    '&(qX&{x9*`#MN3nkZZ2l#CMlfI^#@ZJeaCC#L;eWisk^x6wW_RE>#*SW$0<T1n$a%^9F^PM`Nkm$VNJr%4*f*g?=Ny@%&$N%YUAW'
    '<}TN~m%J<FWVxFFv&B>4e@>QRTVha@aZ!GEsm7QaZL!8ODefxO#2fj4omN7Dq1fOV`#(hukoG%};PP^m>Pm}7zl~xj;Rj=9G$*-8'
    'R4$ys;qrQoEX6zgwe0quF9z9Ul4kN4hzf^2#^al+7~@UYAwNMebfHU0-w<ok3eoi7ue`kNv(lS=hS!UJHJx@?Zs{nkcAriEu}~pN'
    'Jx75bB*Yj`DDw>6-~4&@O$;GgcX*d2h8Q!?zN4_kW-koZcu)u9@wK^~HSdk>lvXVCjxXE53%1n;r$;X8eT=o@?*c%3&#|&>vKY{w'
    'WAoa{2cROS@t9h)MLFdsCPEau4)o8Mep&&e{CX_35}n2cS3+3PbM<-DR|D6P$(Uw1?>D;k#YXB;k%wkr&vs&eooAjTdb&duq~Nbx'
    'g)8u+bm)M4K?jF6>mS;__wMR;7{@&>p&XL#kQ>F%cw=Y;Vj*v>aiQSf>=Lk({g&G6mYyYd7r5EfV(2T+@tssqN;FdH7_7Z*L1ccB'
    'u?o)3r%p<{lct>^rKYw&0w|`^S9gZirIB(g!1EVBj9&aWdYQgBe*K#ARHUar9HLk~^q}L6>x79pFuM1boR7OGbioWa3=xNBj(y?&'
    'q-FX=@TjIEkPTh^@w7m}?ky~pHZA}uac+l$*Yz5ACBa?dqoTHC4ptdl`@f<-x-6zdYZ_R~FC4plqZJoOkv43nZM5OXdYow^%&~#k'
    '%3*;X$&VPsE$w&P>+Nvvw%NBgA3lrEaHc_oBl(0lIMh~T@6)6baHBGtkoO_%!qS0S?>=x+cRF>tm=beC{c*OS#N}}Ip8sA^n|cO2'
    'gl_IOHRWX=I9Rp=r-+&+v7H2R25y=#Y1u+ktf&Y5jn4gZp9Ju1obg&t`gn#(0TVgBuV#336-r|a6I@IM$Un@Fzk2=m^zhwLdUpKd'
    '=q)N-)Tx&U(R5Y4&r2BLlVQktS!P4-d*R&Db>jLGZ)O8RrHy465AnOQC;iT2>lS(3f!{bWS6WF+q_w^F(HrU0?G43jx+UQMzN_RS'
    'T%lNyM%vdeq7$7_&Pi>D)583UCLBn|X~BW5C?{g=k0t5yP(i4}O$;YoM^E=r^-1g*R)dVVcDq;nfhM|Z?mTpK!Bhj?PEk%f&6<hs'
    'z0DlpkiTFu?FB-j9>Y}oR@hWH<*TIMvtf;b^*o0qPuQ|>RZZ>)v3$s@JcssXwT2tmWkuH@_XO%np;WJQn5$JjU#uGQkZh8{I&Qny'
    '4>6e>-Sg6@F@l9XHst5bbRtk?tMU?na=;#C^lAGF<;*12Gn#B!$o3Q@(T8e1n{c$VNz96Rci8g*0NTy~8n=B&h5d0L)>j`tx=BHY'
    'Foz1nWnLYJmEFMo8(rl&0CTaJ;SJkTicTPu@a~-V4=zpiP0xJQ>`R%N64`1%aa61-uQ~>Nd-Bd6CFhflq6~8SCJF3XOYJmDMoC}y'
    'lUcCNM+ox^zQJBGws$Vu>igM8;&F2DTyllBCPr0LjBVo9K2^ydDhk+u&x_}jLG3+T!M0=NhwT71R+yMTk!6oPlc%uQMkelQ@iDQ9'
    'KHMSJ&;Gyde?95^n;M|!mN%#!&3z00Ko|bZhC5C3kld1k-0Sre{_b`Lc6oBR)maV2xMaa6F*FeW<!=!A;)x2WtNuu(zy3{QVBSC&'
    '@(%T+y|x<T-VljQg*~+F;Z*X7K)jPIEW|LmR9M+MaAx7+mOFuX3z)MHJAqg(27(eoI_1353IAts_4PAJy{JHFYKl<vu&}HfJMyu2'
    'U)f5VC;Nd+cXqt@_M%tD#Lk@IAatYZRDAG3+1O>GcDS7iG^r%nwkcG*#)Wh(Rrn@K<(ny4Q7>U;4+<^|1+{TypO!mX=&Fhp>|73i'
    'r{%Jh&*7IWP3Z<;h%=0vAH2und;8Vp&###-I{2LpS{dQ)tb_wjag(OjDxfnS2J0&Bs&cbZg|N!oD;CZ{QN9O?tBv{$pSFfQZA(0c'
    'Wzgj6L73~KJqTQ@U>lhn{6z+UY@?799_X*y5t??`yoN@881kvI_v!OLMn;06gmvvUq@$(L>PkzW<A1cyhbHjj0n>)bDoGt?nx-ht'
    'q0r7omPTC!rFg|nM}D^6sV2e;ax3|8lT%v!jM9AjUNI!?2{{4yiAM?|pLREsN(8A?bW2mE*rPI5QV^}wMG~ltiTW`em#dlnRn_{>'
    'Wv>6k8ghkcRNt9a$hx7L!#pqr6oQozl=hK)viQYedB+9U-W>n*_U!Qc*Q503<JUjE84*W4I+a56s`||RMTwPoj@}-=PG21!y&k;`'
    'HRl{6)cW-B)hIoB`*QTR^vBWP;Wbv%6P?QP;?enG|G%>SulxN!57PeSV=8Z>Olm3K)2ZCoNUm;&lrQDHUM(+sQU5zCE`q;eT*jqI'
    '+)bI~pgmPsc{XgM=l$dtu~9x77l1aF>6%R-FwpsvOD8>Vvuc?jN$UVl+XuLJ;*WLjE^Ia2Yk<)`yCj~VxZ-1m9uQ)yfaH+ML?fV9'
    '>%}ZTr$AnOcB%6{iR)An$#AL;nuZ5uT352UIthMry?Cd!3<9l7T(enl7ejQ2IMW{>%;|}shaNoh3uv1)*?=RvF#ojO5hNW;!!gB<'
    '3Be*dlCgiN!{$&IR9^F;Herr1e`So8Y3b@axLW1xWQxZHKn4@1BCXWK0U9<ZR~~Y8Ls0NX3-ROf8(+HF>GkN%b#moFECvKup;;7}'
    'y>T+1d_WIv&`T|<p0iD|&w{Y3paiVTify=f^hwX^KKaC-qd`sS0R&J-z}>mGt2#|}1-+DgrpyW*E-5^$xN)_RG9JJHQ0;#khD;5L'
    'eCouV!9S{kD|y0`-n}V}(FSb^oaUTKsd6N!fUjB>6TCyD3i=QaE*(=mppIAcU*&dUr91-rmtU}8?O;5g{PK%bk71>h@HjOmezH<E'
    'nIaa;by=$cP;(6<P`L|!0Nw8vu*4NS1|Xv7mM>8lk5-lQSvhibh1@@!iX|3YAr%8A@5gp`FodiZ&mpO>6sMU<$&nnBV->WzqE>Fb'
    '@QaJ{zMz#^`dO5AT|+`7h6M6a&Dp1OfrW7~E7QP+q8h!xT6}6h@TV$6@9ZSC^F0L_vkG+_5qhd>y8lYU(Yee5pEdjLlJMxCHs#_a'
    'oSA~99kqu5<T=Rem^=lZe7c9<1XgzUj&W~k{`3&}bcb)TsE8%>DF<8<`<f@i2r>dqZm*~aJkwM$0Mn`cC43~`aVy@0j}773?gxg{'
    'r{<)o;cTpA=iV^(4n7BQwx4uW86$vT76!o~lWPxa0^-b66*!(A)$eneB<&PTW-oFf9}>?ON3-lIpBYYo7$_It6gQxX0^7CnI8&)%'
    'TiWo3l?4%dHKV^-dDr!t;3c9q+__Zj${WEz6ueVt8TXd=v(`Xx4!vqBiild5NDLPhPU~z6w*~zDF{M{LcfzR#wBWzPElZ}RXaa_}'
    'F0*STqu6PUK%HS~ky<LjNH3QrJd8fkNPk$~Z(Ajr2H0}g<)ruK(3nN>n?arD@4NeUC<yTf_a;1Y#tH7EgS8G!_!HInB3ouFEU~O`'
    'h$=`eIpHy!Bb2!)Yx#;C^x#qARI<byT@B)?D|kMX<`TxW^hox?YdJc!U_LFbD6v>yQMx|#nVjOK*0uOz0F2OFhdU+^ss(vgTM!>#'
    'AOH07`_bDMKfsRvJbH_jQqq&rtCP{`4=L8yv8F+qL7duW4aAmVZ#cn6YmVwJq7Q{hH;>RZfFN<Bf3w!CK}!p+5y3U0M1U$<K~I+v'
    'M-|aFAMJ5^PvDyjpd1w{iO7Q~_7FtY={RF~NiZ7y%|)l?0q8}4NE(a#j0HAwG3c2$9DS|S#XNN`krOT>uX6cP%a~_sVX%bbrq?-q'
    'o)MX{^P>HqX}vn!F8^SPfKydREUqe#JWNpWzD1qZcXK$v@4Fj008Yuu7`<du;`^>!N?BF3xAXF#&_B2|tLQgW0I>|cBfYfJAIeg>'
    'I}l6$BS0<rg)LT(@wO(Uv2IU-XrU9eNsYNxHOJ)Kn9`L~2vOo{IDP99VL%$kHQLGEQ>q41EB47$Ta?u#*DU!7&83d^nM0E~<dZ$c'
    'z#WL;JYy`Zk+I=$CFWhwFoGZE;hyj?_zG7*E=elV8!Z{jGKa^^C(F0)l>INjF1yE2pI_n#)R}$kqy8(Hu2PqeJX^bfem^vP(`>T)'
    'xd(K&e!u;`>EHi7jsk4*(eWr?|Cf0k*g=2*Sw?J53GPjxCyBc^%^yu=Vwm7^PS^n{5DgwG>CMx4(wO}wn7VLnkQ?V>XFn9y_Q?CC'
    '@&K?&k|1@eF03h$L&5XO;1efxUtm)A`@tvePeNWkjw~;pWD^*}%frE}4KOsZ<}C6OL^>?3+NBBgn&2ds!m{(oZJ#vjuIrVa(?>3O'
    '5#0Kdv%GuaOhTKXr*1NXI24WF4}CYE(!`5x{A6$YUdeMxQ_Y*ikZH77fn1L=Z@2kMGFn@{VJfw?kJ2{w{O`bK?K^-UX42a2wULu%'
    'xv0-4DL=h!l91!m&}2;@Pw0+Umx~Z@mN}Fvu}*CvO%!X+Gw))zu5?Rn8x;SXPsB#Ot<lctafAKs*~F2hd{k+u-!0KG9#$hGu{w_Y'
    'l?KrZ*a*~A8C7*JT40eGQOv@1IL=C{PJWY{9On|=s-t=FLj74=UY6Ni9la$3M-BV|>^#+r#Z(tl^h4yTVrsN02+b>pb%RU1ijKQ)'
    'FV_3}S5JDBvkfzv!&!|!6cfNOM_v2-DM@h`#lMk@Gja9En8Pm9>b;#Rk{HaG|D)+|NOs}ohKXW45ylVt7%mM}?<t<0_9pd*jFlFg'
    'o!p_;?kQ3{D93mc|A`aa#F{#>>3=PV0m%bg^-VsT#ON?bIUNkYGtQ{uI4TtEkxF136}x9XJBWTnJ&q0%7e2O+PIv%Iclyum@i0gF'
    'orE$<rhQZ@N*HD}rATsM#4wu?z{t!GJ?;pC3pYw$zD1$zcKK~HS(KE<%dEbMCi&H}s0Z%-Xad|R#uu>YdRAQl(hV%$`OD_zhnag+'
    'S2EBdnGS4R$TNyejf3TUwaoLb9wm;7>k_+>6I`tj*7Ud5Bm$nYOd{sv-{J_AxU)xA9}Y%Bcw!-nPF7MZVL)s2J;zjMS3I7#w8l41'
    'Q)_HFmc8aU%{N~#X6X=jl_*Zvt)YB)89I0xr8SVG8o8R9d}|_`VMM=TVtueagCHDix@ZO{2Z1uNMei8d*ei+HcMIdKXfpNP)Vd#R'
    'uUaxQ>0$-?78y1YSz|f~ZFBQ&UQKM{4nd9icE$2$A)FGl8i1<Vw@ijDA4w!1bFFjqGBkhgwPpI$=y#fZcqTw*{=wP(lE@B#-38!*'
    '8R_B9&E6p+{ONsuHxxCU%GfPGi&ClcC52+UdsNf!3G<nW`3)Ta5TRLP1t@*-=>ERxcH`oz;+plmt*>{zL#=!Fb#HR3c+_KVnU&S<'
    '7p-c}&5v6u%sPR+i+Sop7_k>UjzocJ2JAibP#OC*-j@vxw0qQu&#>6GsF*acg&D5xV<`^B9!@>;5X+>XYaD*-o!EDbp1{fFsGEh7'
    '_&FbFPTYF$EM6W54h)grv{*FeYhG=du6M*uC!^Gtoo9QfdcDi}H|i;MLma&$T=`^B;l8n?htXc+p5R#Fj2nV$aC0cIF}XS33R>y@'
    'ukl(i*jp{LYm6F0FTI3P;532i@Z!Fyf18=#5&U*>D)7#=JxwWzl#o^H;q%<+F!lS*c8n(TbUb$qkCxqXgIUrYsB80Id$#XQJ9!n?'
    '4}yU>eYELTrVc$p?TG%dp^G_w$tUyoh7Lh+;MZ2&;H%zFW0Ap_N7-bd?rj>)!G1NC^=OyAjFN6=eirQQ*G*x;&80H<FvK5mZ0nYg'
    'im8zX8-$&_L@kOQ{E%k9QR#p#V~VBUGoyzS!>Uf9bZ*;dw5j4{PYw^AR*4LwPkI9Po2P9b542g^q+XPMwgm7(iwEmk{8#Gr7{ha?'
    '>zNK5>)Wz2=|5K4d=agxYw~ok2mGMKYc8TRtExpL0lzx=>mWKL5xal2UiClZlWVG;MX_M^P_6)uAL6ubCCj^1Ta44K+$!x4ZaFz9'
    '<g+_VEKws((hPZXMA&c);ynA9VqFAovzwXp&EemWj=~jiI(l*Z_T?!vZcq33k#%#_wrcoqlW6}T20-W+aTPhKT(3P3)cPHy(11(Z'
    '48ES@XmDNce)|6P(diGP6WjKSWO70-UoE_7^XPfA!BNc4im`kHqiye<$6X_S+pimHZGWtrJe#d<HuC6GYj&yV&b<dA;s)JVzYdH?'
    'F-x3j0rxH&-_p~}GWleQ)qL6;T)%@++TQI5j<(^MT9Dn@QtACGtj~5jInnnSgD<RdpsH^=)|>t&>x~|0AX+q-eb<AKYgiDYNLTla'
    '114uXwA<G^vZ<w^bRlXc8a*s^r1XA^*}4v?`KsAOx6!o|rS>Jrn0>lomN3(L5WOXOR+LltH#!gINGve~pF>s2VP3R?RF2oy(!Gbt'
    '(X~K|;s){ra%nq?)AlRX42;=_x`EEUf0eFKM0hiU->fFw;uwK9xJKD_kc8vv430MKLl3YyHBC9F7IGA|4c(B7yncEh2SR3~4IuKI'
    'L7Mig5W(4C;G(uW*tfLV!M0oJgl3_j3*!&rM_N2p;dZy@2bcKZ;!(dZt_I`)fhv^^20B%*(ssshLNHqGaunPDaXf5j2uixC3_&F~'
    '4DJ2E95Zlu(DxoMS%g<2aTl;h;S32+!>j))w0gOV*jlz_`L3PNS$G^dktFudXCbh31un65vBazc`_EJ0lPFG>p7yqbj?|d1*xkkR'
    'Mtl(5p0pWn9Y`uA;*&Ufc5ls!XXJBF>l&{1VYDR}EP8YJ;)kQRqx9%y<nsU*kIv=oX^OB(-yNR)5V4GIJ-I}!pnGcEHOE1g%w4*>'
    '=c3@(R#-dI$t9d-J9pf|;P%amX+FLi&+<se4(+gk?g~gijU~k_MRR%aNU=Hry4o(zgxkA5So@rA0X0CRj5=V8xfT1zhe(D0>C?j;'
    ')9GEk%IBkx1!~HHRN>?aa?SX__6$TjL<vfeL5A8OH1b)v#+v+2Z3@wdIh^e|D$~a@U#`oNi*S?k*I)2LD8?v2tokTR7316@N)ogx'
    'S|@fNBMk%!YKy9xiG7<`!He<(W$92+A3R4%!i~|LWQs@580M9uL`g>a5%N@A;L3a%cqy12uyNILRRiSxfD1K@WF6DFK7r4O&QN^4'
    '$!CikZ`X_RV8D61YfB)d&&4<ly7<+=AL?|(r3$l*vg-^rLey=tUZQG-wjHaXz#VkAm#rtoN(yYTn*cF}Y?-ryIP2)}-O(UAT1ie1'
    '%+7*Pfh(8>B)8_<T+J#Y6SM&a-W0KRpraBo^?Jd@rbJO&(^_z6)qpyEsxHwaRj$iBlMP?cFIKyRFLj!j`I=)!pI?+u29!j>fuKUP'
    'H;yGtDVb+?(Cz6!xhK_bv=FHW0+BlGWVpJqN|`e&B-j)aVvwa06Qv{apw^_oz=?jps4J`(tMIs{u%sHRL(D6je3`G%*@6d@HiYA('
    '@ZbOp9QrwC&dAoYm1Qvlcwz2(**?{qS@5@&i5GH%n)ZSbO}r!uX2&Hdyy0_0B0c6bLk|RweOH<jos8a8o1*tL+?axV5epb^0sPMZ'
    '@vB84+on6gw17#@U?xl)knnMCA979k<(F^O#Z^qcliYE?{6ZgDW0)KZI++j`j`pHT*|^CTtrM+eUy{o7<*Wj&lhL}r{Guks$uWQV'
    'rAKR==kqI6Mv<E?AcbVkcSgTj7qbcF#9S`dScJEa^vL;$vU-DXbx3}!#+^dWF&<pZuv1480?14?Nn#Rc3~>BvK=@bNh#BLt0tO^}'
    'CgdzAvP+O)s>^pXiHEgKEfl$A1(uT$o~aSz2`MaU$=LL3zN|3CClVnRI8k}c>4g?d-;Y+Z8qURyWP<Y>lZ_u%xTsByf>?iQJj;qX'
    'x8Sj&qv=J7)B$d~1>Fa=<TEz0OKQ;oO-ac_$5lwN0pUd%hM^BV^x-lG->m+k^iWi&m_jtNz*6KOOct1$YKn>0<f4Uzumg=`1Gp&V'
    ';2;gEZ(<@OGA(mk^NbYX()h2!{&doS3mtA?)rY_(NZuzJmS9-Z_WXoAW7Oqf_!}oXL~V+BvaBrJK=h!zhS3H7L%a$ui|?)I+v{T0'
    'M~Sg2zq7}o%iPqO-20aP?31qOJ7*|nI=;oL^SekVHiq4ZzJ(ouCo&U!0Dq?V(C)9c4Atu2W>-MC*Fd=C?l5_mzl+X6Z~>}2E3R)='
    'M5HbiJM`du2PzS^egMSr&itTMsQM>R6?BpbW=D`TKKgf2g>x!|vnT+Cwm$3URG>6`<|lgYudK#15Z&~zRc5`?2{ps{8M39Dp5dYS'
    '8ZOGy7e9>N97f0oZ%4iU?E&u4%afy@M<?lvH!mqP`_UCZjy1?O+Too$z!$K$ApD%1nGS6+hc6G$4p}_H`Otla-?P>6CqIr(=&hyJ'
    'K0Z163)w%#@TuD;*n4zxa(uF5PijlOQ1O3ud<L(+|2wCh`0C(E^ksCg|Kyqc=c4=~!mwGzt<v3vnLaS(3tqt2>shwc*B-Octj^;r'
    'kRysQLSl)2R&Pdcz6Y?rJ$y6Tn8spH<*}e>K+@mul=kBF@n5zNj*Tw{vx>a|UL3zY8~yE!z=mx5-T-M?{&8h(^d5o>$9{Q)@Ks&V'
    's|ALs>Gc;F8z`QaVlSdvL3n$T+=1jf$FxtR3Z+b#Wo_|KqLZR42|)Gg_~iSemoG<e)4%*QIz5x!#a-&EKobuWwRG*gfm2H;8hXbX'
    '+CJyW3O7Mo?z|(E-9t#xLxAAuZ%3Fw@YPSJBSikE@`Nq*@IZvp)3d{qv!C9jhbJ$7fWzgV$9ATRq5G0^#^X)8$~lQ6@lWceXCXns'
    '|9XiVaFyRx!lP1vJ8&sE!WK5~<WQfCHkj&9^i@)!Pi#LKFx)gyY<&2w{aJDZYP6h)Lly&BsT2V*ml>;-yKD+^!;-DoOVJUWW8(o;'
    'E?;q%g#OLmC(2gqfy9cAu8S)afXM`HK87AJ?sw>V7{I^Dj@!i?wxnTGX@oI%3nk<2_Bfdx`8Sg$zGp4aVXRZdqj&v}nvj0Yeep3O'
    ')*iN5?YLolTm;jMl^w99qR?f@9?Ck~z^RPGI{}{$Y((42&W)BJ6<^!Su58giajb4*(`|r>IA*{}^FVdfN7T!zx%jdE+AE=ymcisF'
    '&H@OLtmq-3h#ZlxNUs&9i0#i&E2$a|VHTF^{r_k0UAvn|vb52^l0~1MlprO`#@HY#YmEU{l~04sF{UqLwDiiBgw@EBS}9>DxBvUu'
    '*SKY*BtzBAe0Y1-6jo+rTz5q5>$7<be@Z?qcb>Fb{NLmkR>FWF-)69l>BM2xWsUK+?@f}y>}r4!PvZoW+dKIa+#0?AQi~uYz~Mj*'
    'oifyH&6rh8`Vq2a*noFnw!3n!!y@2cPFx9xK#$N>J-`Owc>0dP2S7LcJaH|ESt38!o+#l2$UWdCk(=P0>HK2U?~^rLJ<W#X?Ytme'
    'GS-4^Q;-DouHG&MTv5^HsOST&;fA6BG9WH|OiotNxw0cOLE){mIP`At0L4a=E$I)LE3YXo4z1NLD0xZGe#VfE(LknX5}<e-QMs$A'
    '$;8>hka>l*{P1A87&e|VV<svdb;QGRoW1y_S%4V0s9m7%VoTfr@pUJJ8T?F$^@jJ$ko6-qXq^A!_o^z5mkAAwh87;>UV!D0T<OHH'
    'iYd?MA88o)FaP{3p0!${f~6=SP%EjaKk@B{2Q&0qZ9DXWoyI0w_!wx9e0LC4l#U_NU$;7SGfSkM#&h;A!26KFWwuqj>u9sXK?!0d'
    'CLdU7M<W3VgBPl@1|d_BZz2J3vkht1SlhV)Ka~wyr<jA!5-&T?ns4A-YZ#b?`+UgB2JZV6ZcU04VdWsq!WKW0?+`zb!jkE8C;yIP'
    'MS&$=UW3qFYfW4G`%#zyIc6-&?py^7vk$xhUtdxG4evlUzQ3p!EPL5R=!X2}{9{@zd_bOfB>K)w_Cxel&`tJZvc0}@LkWfOc=oob'
    'B)`?a?rbaht@+b;fir5zyplt3k3e_?C0&jnm|NFZ<J4$KO}Nc-!8URtw3z2aU6rRmbc3m|Y-V(gx#_gayGX!7M>2fCzQ_{4ZyER7'
    '!_Q`|&~(mTUKABiA2F%Z?Re7t+v&;i>wf?@M89619v+<OkHf#ee64>UpZt9C`t`}*vZOWL^HLxX7l?toeQLorOCWX^ghN%}$={Bk'
    '7>f>qJBNS4t)4?!m=H|202Q=9{w7t3*wT*sBrC^N(0o%}MU}55TnST{6m9&hH$Q?WwZL^H{GwTmenU4B{PUW?4fszoI^|>|rdCNR'
    'Kr1-SRF<^jRjL#QX9|V2Vr5X}wD|&W^P>~5vU-UzC<jk_0n}8&Mo;_kIp0BF=q*<BX?CL{$A}WVH`H*|U(Owylec-9u1Z7;yoJ&f'
    's!SF^<Jfmt40=V(QGgvF9s+q8WD~Y0T6OT!-7ev0nt8z2!OVnZWis0dXXn9yBVy3-5fTY0K_&~j=Na`I-vl_|T4+TMs51R$iF_7r'
    '1Pz(0-<5i6U?to7g)VEUs8DRz8x2l)b<xW4(Pv&3>97hq`MY}DQ~&g4DuI()Q+`R?_sET{G6ay(V7s3NUp3&lI>ZVtLfmR4cPP(E'
    'L|q|Vvd@yJpNn(sI1Um4-_4`(w2$6MfT-vbnitLbSwC-sB-XiG(`8qy6crR-8j}M_i`6pU|NZax|JRY5D@A5jq`Xz5ho*69dnsJh'
    'HqX{JM$SQ2!&pYN89zZtRci;D9K<o|4M+20QEoBPhC!uYBmRq?TSQn784weUkX(d{&erbJC;NM>X~ClHC>mGaVRaZDf|!@nS1ymE'
    'tc?AA`~p1>eWxbZbuWYpq6^O9Se1EWHw<L0af8FjkA1jHYPVEF6ZR?n0fO3t5?Fu0Mh*MkRfnJUu3d?MSr~%>#04s@eDVl|Qq6bW'
    'qj#r=ztotWS#*(&5p4xOKo%$YN#;IwtvjQZp`t$!-JQRoJCHMO?>3ivS-MFVv)AUMWV`OU+tCHV7%sNhszqSO1D~(Jc1qomQ;?)f'
    'Lx;oBVB9Z4a4oBCa&(Tf-iXvk=M4En>I^~*%wP;29$}fdvt;kdlgE2D7YKhZC`T6j7xfQgBI41UW?@J4C?irgP#0+7XsR$Cn;%hG'
    '{jjL7B--8>HP?f__&ik3ldauO7v4k>FwfYQjqcPCO&s%Zm*<M=tNZ&h=3=<nF!3X2knRT5VT~n7D<A_$x2p<gQOmd=IMV~NGNzV;'
    '9te6TD=SOKmpcu7uPbcl#@tC$vdp+(zE?fkK5cF*K-DxreyjO0S0NA5f=#fy3ceK|`iP`7OQWKz_Iy^33UI5~ERbd?>OmkL^&0}Y'
    'FvY8Y|H1_~Sgfo-KwUOD;%E=7F1w22XJXyv;iG-J3o})N|DX5pD>@JmV$ac;WywQ$cGHjH*kp<1&e5&$xD~94I&+T4++T6UQ@0MZ'
    'yaPjc&GBrG56gT&8COvqr4F2~$pyn(1o9+iDq_SRQHxVkE({}jGdzI5WY|6|r;t5=<t|59k9>_96SOFqjUi5=#iTbYuF%zHj2z3P'
    'aL3%#RdG)SX;NPm=#rN^t_~=eIeyrlgF%CIb&?bme*Zt)Fv6d<`h(9~lO@dkzyFPMzjzKiXf%X>pu~TEc#vkk@zDsYbSr3wfB=vr'
    'I*xE61tpIu?_@{a4+3@RndDfKf8Dxn`Z@f+`vm=0IUh_Z%K*<ylj#|c2i#(<mAeKze-5&PI`-CZCX(AyO~kzT)=4f>Ec(#pCWGp_'
    '_+q1e_hK~16kF)WR+~xYhm6gJF*IYT*z7!S`UjKGY<0)Awa>djJ6Hho192-IH%SFZ?wUO-(0peaMcL*Yml;Cdv;#IEv`Z0P%0C@%'
    'L%-lwV5vr9F_#LJHa^a$i1*Fb>*vY#?habxH0L4o=o2uJ<F8#Z=L$J^n_E30JlcQD(3hT_20Ps!P2BXluMYou{QmW8dV}QV)^POp'
    'ke&mlT6*p%ODCUm_<xyQOuy7E2ILj%lC%l^!)ceqjSImx4g!RbyD3IwUeUax?~Z;!Y=SJYzyEUd`gMJy*ekf85e#egv8E$nVkp50'
    '2wU-%OTC^>KP_ifQCMN_<Lc(MQOw6sGnv!sn^mc4$L#E@A@9o!4HJ>}tcfnhZSgYevZ6gg^DIxVua^@FF*m)G9Z*&qm;=_F1zAwD'
    '$Ea=6eTOFQ+1qmWU<<A6&x>9$Seb1V-HaUP7jn90$!Si$w-i=F-nXzZFBh0)k|@5pW;_H)$T8`?F-Mfh&CoaSD|C3MJ>KX_2io1H'
    'TN~b^=AZyJ4yAH*N9a$fyGU~E?kzy3>V-ZV%?5%3>Bfnc30S37o=Wp;J?XT{Cg@5kz!f0G_1^ei&GRRs4o2n>Ey;M+%L^%~FI+=Q'
    '7_;bZRJpxM2-raxsJap*+lZ1x9dH*-fbppXSKAP;1U$4k2J_}>bctB8{7nd-PKDh=5(a=7-Gr%YUQH3CfVj0L)IgSRt;tgWOfj<>'
    'j-jSikY?oX-IKqRP1MpsU~RPU>R$Q0gpS1)MY2Y>%#d%Om#)s}XR|td(Vg~gyl5Hr${=Q5+`(}-6<h2A{#>^umSP*?yLZ2Cz5Ds>'
    't)rjP+o(&4GP>PbF&GasbWRthB=9#1t|{?<UCzhIpNi|Sn+|+DMAJSR%V)FTITHk;{rUtF6vHU5Jh^@N&>}M+1M1~rN3E{_4p@BG'
    'X|ad_`0Izip1eClFCu1zuNI40(caqX%|=ZFQwEGM`IKm4gsm_O0<I~x<GL!<Y-P4;`cV&QOS<TOkUXNNE@#oFpcp9U&T<oeu&M=%'
    'hjWHlBC;{``zDrCqu?!ilLCiJO;IPeclMht_`hutrQ6$-56&5@si?R_S19D5rQ^_RjkB(WrE)DLg}m<7SE|%LJn)F!Oaxs-h{5vf'
    '+1cB7zOA0<3NAJT&Gx2|DUp*J{ifiT^swtat*K?(*&2QU-XNhH-on2*-%;oTA{0#U6y|G&VrPoP<<TXE_@+0%?)C?>f_e3}UZrl8'
    ')S_C^Da?>Cd4X^KC|-wyF(VTC*Rh(~$J37=JxjZ;5G>G(0aQB=Gka<BU|>PDNW$a+C(~cIlPE#~b<^DsTuaRK%pJ%~t_?{)EE1DE'
    'C$B!OqhrOXu(As{`#yODTj~j(#n;>OE{_5J?3q7zx{>W^P98mn?n>{Qv*}FFl$S3L-@UU4Fof0?(D$X~$hxQ#a3rsD=S(Dzr{zMV'
    'bSFznqalvE^!LA(qrrk)z4lrpnbkL8#Vzr8xr4Z0bw4u;c~#9XaTm9$5_zko&o${CEMS=~mJ5k^Uek+ca_|7|&y@F5_?X8^7?o&$'
    '_Efo?F2{ZMYk&7(Osa0b5I;&x|7Pcunm3!HgkAGZ`|19B>UZB)@x2wxJQJI1w7GqyDYb{8H>=9~e0Xrn-M&l2b=~JrFa<ZCyqvOG'
    'xD(dB(w~@=TNTS|^o_V(u7Fh<%nMd#gyl^_Z`#C_{0>{3S2IKLmy+V$<(1%#UP*L=p^N_3=WXCfW(6|_-u?ft<rE|hWw0`WUCSxs'
    '5R_z%ZD4C6AJYdm>owoaZ-EVhrw+g*6u`OEl$`v^QOV;=SIush@?V1J>kqPd%Kz5jaYmiV*`vnKB(E!ympoAp-20ad{H4nrH_=P>'
    '^=O=Zoei)QoT0Os;xTRM!TIoEO&Suw;k!~E2DWAegLpfie);+<zpue(9nON~GFvoJE;c7>pU6`*sEcBoy8O2GP#dkUl0l94&tT5x'
    'T&XJyb)@WFCW+sp$T<pQp@rD`xbtMs56G%Vk0RX}9<GgfTGO>;dzEQ{qfjz!yet;G8>)$XU8S+vNW@(t(p&`MjmB`_{&Ur=*|BYw'
    'E4Ae)gK=xO@)j~~0AwJmN>Fd`I&7oo?VVPuv&OePb`}TD4a0z|zU2|$scoLmW4H!!5t3Uwvb%P2%l*2GSnFLzz+21rr>})45C?*K'
    ')uMh=cP%6kITBR#tZZFXLS%1yMsAlYkhd|W)3djaNQ8O=MN&39@j`BLMme8HuwuU)o)L5loa!oIZdJkySLQEdIAFw_#ou1y<saO{'
    '%bQFtf{2m@?TyLx(d+BRAiYBDsy3+$b#mCJUFOE1-+trNNIH%!CoA#qF)_AV_n8+3Qu(H7VJS?e#h6jZLh=wjCc|{!^d|JJ2&D$2'
    '_p25isB&w$$&41I+-F<!nuA3fUVHvTHcb~{KDxN~qH_^!rc86b%CCpnDp-32i&Q{g_9Ng*HUCu?HGAtS&|Au>A@HyYD44ZpC$mL^'
    'd|D_b6u~1fYV_-K(p@JP%RZ*t!=xcSavYpZfff0hX^s+h7`yDvdY1_E>N0{1atPG@k<cF&xTxg*Xtd+TVO_Bh1x|?JXcL7>a8;5w'
    '$;;PAWX)}g;hB0xx)kK3kToY{T@1Fy&@na&Z%q(kV(Z}LUz*|gy**h&WPqBQN^GzKX`~g2^~XHs`;FK#_;G11!)i(eHmJ~F+gOc$'
    'iRvmT=ORoR0dc$ZWn@tgyq&tqvTAj8lHFL4>syRmFHbAKa+<MwCz9AUjEixA!Pn{C6oyO=7=yNqJ2}yKpQ4-+mY4Y_kgr;sY4*5A'
    ';ashS2{{R97OK%o!?xIOoF+;o5pyQh>(GVr$#9Pj>B4Y7%of%yE}PrG1p?I$9lGWUkdxR+?M1mZC@r~r1e((?+bEd_DuHD3jQ53X'
    'LDCRWw3rnUt^UZL%=sm`L#X?l+z6G^8l0CKU8w$g&wG=C(Ld%!MqpwShR*9@#2`2MJQ#x%6xCprxbrZxwSMjJ3>5h+kKx2e{W#aA'
    'P|jpMl|>t2pkROC>Bob8s&$#P9{jz5ORU-SzV*sVD!Og!r2f^b4jHEw{q)>^W;8w<=Eqr1$izgBgM8a)fM9vTy-DJ1k+NR6sragJ'
    'y5tn@geP=GF{0OR?m5;}>USiadTiS2>lBp{cGO%Il2}~Fh@K($AA=l5P~BvDGe$`G>kz7W1%NNx5?H!M3YdH>2s0iXCVDn+iaE<r'
    '2R@xU+B?@&zUhV!`YI4{{ngT1kRsj8qY2Vto2R63P|aV)(D`jy0N-M1;4krj7T^WXmnw!v8XBQ1bF>(hw0uisQ<=;Iqst`w#0uN-'
    '8=C|OD^diz3&eKmD^kJ5SAh^DpGQFuOayvfI}eX(H8Y!t#>+#41tk5>?Oo=-qoh#v;Gs!eV`hh%mK-?ODtTFWqgC#90YIX-t+(xH'
    'V9VT^`crt4)_<7aF+1(~h){+$!ThUUIhqKwY-q?Sr7bvpf2_tF_Pa;AIya_~&WcqF#A+GT1so>0-4;{yof!>*ai@HUbS9N!kMZVm'
    '@ZAH>k0zfnAdKHTKcvoX$GAm$ectNG$Q?bUqz1y5rNlwb(2W$0M{wjLQaj7CEBKUnzHL5R{po;@N6uE{!pS4lnnfO6B!X#WC+x$6'
    '|78E|He5V%*CJQsQ~EVXR(zQUM!z*ZqYw4)X20;pY=pT{O&=sjo7i|10+Sn)BbI{qD7AwIk30DyF23q7bgWw9F%iIPI75MkA_iD&'
    'o;3Tmb-H(H5p@a}1+;66#4gi6B_|lqEs&r@Yp8!_8?;o>Zzd;{DN|3V>j7@wQE^?wDx41x{nrC$rDW%f-ZfC9QpHD@hTdM*oG;L%'
    'dWxOHusczWwX*~CE8REb#x@?;+#-4`kOL;sk9<^RZ7ZXJR7D4wA^QhIo3i|ogMQ&i75-Y2L3r8~#9Dv7Lb6@elv|72qKWuGw~(%;'
    'pQ*8;$^cy)BMJb)Ek-et2&PzJfElTG3l6p|gh1R<h~4C3G=U59<8uqD8UP~+0%Kl^wBSHvdC#gR{@Y9%LnP;>lBP{WWO9K!GBLun'
    'wHnWQjbZ2Z@eV<2Qw^(T*Yqz8sBmDOgQNU<Kn6I8sWKH%e$;_~g5hsHf;9lU&b~G~u#xf5wI!&<F16S-7JDd5Pc|8XcO?nhvH(?U'
    'pKyDU*h{8*Xt%e30~J>S7r=Sj<<qi@P@XuE<cV(w=9Kh(OyvUfp*;oi6;1I5Bm1(4PCuxhaurry9whW4?4$MyLp}|ttF&sa5HkM!'
    'YuN)a6m~B9_Rj~*{EnA}Tb;nO2&9_Bg!9pXT`_r|#AU!_ZsMpFuR2D@m`Ls@85iGX&E&wqD8oyZg>iLmaBU2Fu3H-nY6KJ|LQR7w'
    'tbx@Mnwte}E~9og{Zvbqpk%0BR#qCy<LUA8A;ixeODaxx%xNw_GK@sXbwWwI5Q%Bl_1mIXV`op(zNuWAKru-U%Tfo1Oi_%U$o%$c'
    'ERgEEM_Ad#WQ>Q8879=Y*&_62-V%hJW73wdWiIuQ;*X=p4Eq35BMhaA&(&G5R$tqodxlInYqnIm_S{7%&CKl!VLvHjrYx-gzDtb8'
    '>I;xN7Uoh*2*8}=NVjugJPtN@E?wzx@6NrJJF*}QZnJtxR4S3RvFDqti{wC}d~U&n#ShGp4a(efKdd8aK7W;NpkvP0&q**D#L^E?'
    '?7O#DiLAqoDp?2`n#^F$UZpzxjcOikx=X|S3DPmM75LzJj$i@0aYu!d9zor*mlMgZYYC8_85;E#EUI<q57uyN3O+UR8jmnQ6uRhl'
    'r|8ZZkX3ihmUKMh$+ys3l!#${om39r+dA1FvF~Wj4DR*@6`Ha^PYDl6-}&9_`WzE?J;pB48_tELd=HWghKt*ZSXg2Mx$~1`HIdXJ'
    'oRrL;S#ES-Uo9@WsV+8Qtya;EyCAdKM$)Pf5<1&)U%9BwBa=H}>PTNWq1_8?Zp##EdIo}(ItcTPqe-##*o4;0!rWo1-H#Pr$;^7X'
    'ittNaB`PkvR*isRS$hO`9ffk;)jP-AI<NYcl1H`Ht2tOapl!}gNpRGd7_-3cff7@(YQacfX)~$wSDM}Kd_KML)5H?7!&4-8uG^Q4'
    ';gzgnCwN1pRbci!+{#)tudFDgs80rlfl92Du9n<EIGGo{@$@53mVqn?cMgwN%~mj8Zp^eMZ8K73(PTh=Q45)GR|5&sH>)~Kopqf<'
    'h{qo!#TXtC5;xv0&N&Q+1FbqI%`KXoKg?-NC_tQd(KD8|z+K~3J~fFS(P&yef0<Hjh2%qyy$mcimm~H9bfd|!Mhc(0<YRB=NeP>y'
    '=HrrFV%ls1<UljQsDIw-n51BmidocM)9LubgFCAxuaLvHcS#P%s<u0u&O8fDaMn^PrbrH^H)?p5-hUdQd0q|MIW}jRV|n^R&a)Wx'
    'sw&IW<d5m7Ty&d*D1co}3(*sVT^S847J(8@vEqg?%PD9LL5y^12z^ew`-r><kkE{C?u!00*JtHq!r5OaiZzP1q)F%IpR=YzQea_M'
    'N)UCGBEF**Ku_4X!l28yW{qr4Ht`g(F)k%vYgQC`XcM=qB;~oh`Yne>Cc32&_s&PUvqt(Z1JRl$1Jt`P-fZNez~~Z&+;5Y{rl&UD'
    'SKJYx(+$2xj9dbzb3VN<Gi+1R2B#LCR74gf2Z1PgvdEz-m!`wjJH#p1@oL(vrca~Lk-l0P+Nd|&v(=G~%p4A`r;9;@k|%`oxpm!}'
    '!2Mn<bU{|^7fjBE*g)ZQa&ym<F#DP#S@3ZeNEfakr&l|&iIZY<xw<FJPGUKeEJNd{xx)C|@OkL&12h(lCK3lAC$-bAe&DaZ<;5?)'
    'Iyr3!8pUjt;MxddODa?Xjv=;`aU<jItXI$w56oScES_%mT?+S!$QAU0#=y-u?y9_;Ie+U}$I6l*8{ZkPzjU^Icp$-*5l*+Qho0qT'
    '+m0MZ{Crz=5%jB5;UWZ-N@{j)(YXr62!(%knJaAbU{@Y_{ZYY*({&7Fg9~FrQQori!=e^Lf`7^q0xs8CG02;17Sg@LJ-I4mwa6rR'
    '@wH6vioG0Bx>L1<v)tI<TV<A=X(>&Iv+!*pjk|RRu(r&D;k02<Z{pzkBEBU;tISB*?G__eEOT#K{cohpi|KrhsU#Xam?)*uOvP!<'
    '4Da_KHJayDG$tL1Qdz}OhWWhg8O8?~F9bUU@j5Ak8S_rB<}c;rD)!Pfl7|ojx2_YfHJ-H-*Qh2+3TNqA>%!}7)Jkp63>qg4a+Yc*'
    'K4z0qBDHzC0|ijqYLzN!3rPnr2m?FJe4*Qh2uajD|LFwLwl#$F!vnnf@BvE#RY#y(b7b>Z9jWeTWn+80WJfEPQ3IM+Ri(MD?J~Ra'
    '$(>@^o~p{$FfC+k69z?M&?U`hZ<3Ua9AvB_zwyx=D<sV~=QgKI7MMLy%~x#?u}vAQ%=pPq=gP!!I3HBU>8XrjS(%xuDV%%ivZp;q'
    'U5W7%z5rPdkyFG=n3B~sKTO^qzdC%4UPp(ox~GRPPvEbAbWh%&y?uY?C16^?!1_f*H{Qf3Kj6SQp;tv2V-O5@%ZlPU>V{^KTv=NA'
    'EioRhF6^wM$#xja^R!+hQ*=YND|285?{$s6#a$?WOCR~yMsCc!m7)PdHusX3_K{CIV*z!jlrve9NZYVvOcUe7g&`_op7^p%XhYS)'
    '0m>i6?yYhgnpW6k+m4LIqBkkA0!w$VaF@g!;S$ALjiIV1y$H6BBP)SfD)^Ig<4-Ek-ksAiGBw}C#JX*n6Wpk$D%sD9BiG2V4wvg?'
    'd<S+yob|i1u_Pi`Y<BE$MMN&wD!ylIQJM@QEb}awDSD}}dTps{HV_WWWR=EuE*{}s9Qk$4dXX!y^#)$2(kVLv1RB)P<u-=3fL(I5'
    '`p9zeLyzfF9lQ6+XwvD`=lVt`fQyo_2^+Wh$UP4ob6~hvoSqsLz7n2mpW^4Nx?$qRT0UqfqsBTMX-boD7s&K046%ZLTIThfYzhj2'
    'TfejCzMS<Yb!=@o{@O<KQQ3!@BNXu`Q$;5VVr;dkP?O$OHFX|!_jt#rZjFlGz!4hONGHbGXC<PRihZ~A_1NV$b3kmH$Os(M*1%Y{'
    '%n7iGmoq1@Mwe!{%9I{Ee$A#%$HiJE)8#okZY(=9NM1+P1mrmKdY^CZ0L$cW<qj4#Sgw^;xUNcPeZOb?kX*~DXVF|wRsjP<C9%da'
    'hva*cl$E3Y$0$nNu>yip$K`uOD8O92IeCA4cJSi$p{Cz`cXn`g_-@q#56vW4igdc<5Tr|kUZ*t!d)M9G9<6!%exv1}Gg~veyY6o#'
    '(}^5)*M4qx2Wyw3S-OfmOeqT;xNc5A)h0mmjRCt?jG>h5oMjb|Q}pvtalkz=_-U0ari;X_-ocxFIz<E4rvY?H*+ohv)tc^`v{jNk'
    'ff3v(eL~&6yBMn?fPbQR5BN+`V#KUx(ki?<I;~EtupITtv`^_Mmza&xeT&7D|41nP+qX@&31h0YaFk9FUthQ^9CwT;+WDNa40b0|'
    'iE^*87E1|e0RsGB;Xva%(MEy-2M5P^Sx~ZIl(ZR+#>at^)W?pU2QFevDLo!623i@%Cu5$(-aNsmYz20co_TUNnvpUl4JvchoA(>&'
    'Jk?aEkc&&SdQw97=F3;FUrR_L%t)8=y1Th@3XE>;6SR+faoN3uD!a29CEO5`4o?j__N*$!Q&zXzp!f=h*toYq4wY>Y(9z`=|0-2r'
    'bL@DN7p1q@sWrASqZsv%|Lmi#VcYerELY#}&2IvC)>!>tx|3N=hn^+7aV;%VrGT5%XzH4W$0zUp@s6WKV~cOxL|@}Tk@R0lmqN($'
    '5T~3mW^{gG9(l1!=&Pnf3|=!WOtKYv!a<|XQW&gOOqLeSZ4grTX1QhH6gYf|>8HYEGtsNwWNRC$MYjx63uPE^mdcoeUVs$KX>-EF'
    '58e=90}l|Fi*ZQtZ^}e<{i(pe1s*MjYqCjrGvsJ?*Q5lOqj^q`IB7t1IMEa~H<c-D80(qx!4QJ0D+UJdSLeE`&V5rl&B#~J%t4)j'
    'k1FRrDBWC6$RAVE{dA|F+(RQqN_Ms^%I*IPr^dv99!Icft7*^xdx|zkk8WEL2Fsd?2A@f)VO)`i3})n|A_=M<voPal8S5=HJ1yFQ'
    'oA{p^`!Z7X_>%sxP27d)OX}7fUXiQG3~GH+%7eFW5078nJ1r#>V{c<x9FIz9mfuK=Zh9}4U|&x!Kb7=-1>T)Ms$JrzEu$zMPZ4S@'
    'CJ2+lcs;hU*13kJsGZQ6+3ke8da_^&trkFS)7y_rxP!a2%#Cdi+VGNY1L|F@H-ZuzbIx}`;!zQwe?yK4&RBqStQZnb%J6z8nmKE}'
    'SYuOjF*ZrRMeNqqU_2xJt-9uu-@Rv%1g7Z<!wZq6#N37ybBN*)UVNM)6^H{4uxpbuMHXc+Zze~;2E%3RN8KzJl(dh7POhh)DLBn6'
    'D+ThX6BHk41A^$D55|LD;l|3)3Kk0Pfg~X3ng5TPn04~0mkp0}3YR*#TDWvjI<dTY#@t+Rs>(XZH}`Rh*Ih!NIvg>|zlqf1Ed>|M'
    'b=X_wVcX!kI8H}M_j<h1qbzcmoxb|p>H4E=WpegvO2np#u0(~N_)}7WMo=CVp)ev;%W_W3?Pi^G2Mm`2{iz~V9GJw*L&sHnB9nbY'
    'v`N9;m0%xE1^vP2%=s8L5IbZ^uT2r>H<sB1KsO*Ik=TPBtCLJSw+y5kg(e<eP8MUhP=Lhzsm$aRrX}ni{vAlf`F;E%p2Fk>)&qRW'
    '(Me_gk`S#ncB_~{!s&(aFatU@C<Ww*u|$dr(owB(mvY}BqCssZHox)7P}!Z11+(>VH|%@6AsF?~aMK==++H<mzEj413X~P^5_{v7'
    'qAW_G*Q6=}N(uv~xXwr<SC)jYG?YrC8rB#IV6S*JXvkX5DDSMAK<hZdj7%zfj=~^yzAAicHGK>#2!y6h=p(7!QWJOedsB-3FTNJa'
    'Yu76YWq$1uO8q|3>Jb)Z$kUwP;(zaeS%qcGZynY^p7B!VxAe~)F|`qFV4D!eid*hDhdj{c;(FHf8+ovz66Q@c5t`HgdNcu&3O(lg'
    'EZLCmV_Au+FB)O!tllz4F)_d%FC|aA#8I={>)$b}FWkm<q|YwzDNIf!?}^SMz%mUucG+j*SS5>Nd9FU>CjJvQYq~nCj>0D^$sr>a'
    'q_&GJPL}Mpp6$`rcfXEo;(PC-m3v6RZNpU7m2kG4uo~$4!*XY@*ZQy=4qC(D&`=iuSp^rzHX{{Yj>;=W536q~Z0NiiGWf|?A$=Dy'
    'slEl1DxtfwV>2uPdCum8K85Iqke@-4Ovl~Bq;bj#6tH<ch3UZri8Yj&6$_9xm_3q;oP@zwnD92h)GCvmeCJvy9c0APf=BE~8-NwV'
    'm<ra^Vn79T3}=iqvk0)nDLE@H1B^-5sjFdkORPOBs_~Vd@FJWtSb3e%d-q?ZH+Z1^CHV{EdSoH)3fN?L+vT^|m(XTZ_fh<?bCj{Z'
    'MyUjArNlfA_R`CPw`cE954&$c0_eUwe0g&G>K$_nJIF3Lia$cY>VEFcM?KhXYHoB)*A8_tT2{_(Vtwcd{$akUJB7{_536%7SXLd<'
    '4Ht{r(edHw8NylBRWW}cK{<*PBhWag=!JDeT@VSpU%n#n;cz&*<VC;feUcp6gD>d#I{By-l1rz#DAmltK1>PgMn0pAs=?(9s#B1X'
    'vjOzgAOu?2YH&U`jY3(AtF<u-{X?Udq$W-Y&p<+Dob0;jMuXsHbLig`$tdPVkR|@wWXV58@23ht|CES3f}L^?{Ch}1(594<!Z8+_'
    '`BBFzfz#3Z?`Xld8oovu*q~r9Clg#5tcmLu055A!S<cY9jUS=9fvc0xpQE=-!uO!@OB3TNFd&L~w3sf@yxDX|Ctxw=G)gLrs1na%'
    '#Ltyy86vDm3>l4<yH1#YaOq&|h<M8p14r4fiAy4&J|KQFGD54*Ep_%5G9(N?$72Fo{D?|Uo==_>DKa4dRWeNpwiCJM2vzneD!CRo'
    'P?<IzBqWhi1HS=e0}NgHFj?LQp=li(z8`QYtR9WZM8_HG(g-;MH6*&3CPaSFj2}rQ6i*T~Z50}?x?RDN<$kZ7H@=W08&OKHog_*c'
    'A3G+?rtHe`%N8I_*@%eSL*1Kb#8I#-O(!Zkxn^PPj3I$E9A~|Z=_`*{=Z5^i=3tb0&UCT@fqzTA8*km5Aa<X*OplM+JMLXy^n1y5'
    'JGl-Amgl~IpaTXR`uF&woqZE|tR{m$cCWZQKq%a&5+NcqfAek%{W<QrV6;|th;7pn&F-hstUK;4#n%)W!@E_R(WS1{%O7ZX?m-MP'
    'o$REw>M+YfR@@K`eQy-u!A+-iIiHtk>pRY#@Z3=rfLIfCvZ=cN9UmOE&6Zezn9c(8pkL1xDm)a$Rky?_uz#W$d>#KpzE|Ij2=11$'
    'd@)L4V<`Sx%3L{+)D!38r-8v?hQKAmBH2RqMEtI{*|wrrc2<H9<qF^+9jr)6uZ8eTMZ-f4%V+delQLnG8R*^F!Rguix7~x&m%kqU'
    '^-xz!@*tio5V-chhSD?|4j#Gfuk>v;9aH?-_j2o2Uh9%{OBn|zQ(ah{ONu_>M^<0DotgCq0dPCO!qnnFCEH;VY%6WhFdim5%_s0*'
    '`NF$PF+P|TUbwznj^)P0^a`0YP&Kv0?8npV+S7XTYVajcQK7d;my!huU#1Z7mTKv2Dy|GBC@eM2|3h3aT9ub_=#lC-X<R4!trljU'
    '$Bz2hP;kzeI&jLAPQsjhW!um_dsz$@;`KjcNOarRe@QaJYyP*j*J^pk&#M2St&#g&r}63#w{H0<yIaH%#s#syy-6C#cv+7ehqw^q'
    'F&V^wK_<Nl1F|GFRNKPjU*6SOJEPIeoRF!cpS0&J`=pZ+80SVPFPDGO4BacHliYSB7-m^ht7!?~9Dp9rzAmn&lgCNpC~3S%+_{6p'
    'fnCTY9*BpQG#V5_a%-S@?~<5y70C*Z24L<Re5Of4KBz#lOq<4ZgA`3TSDPPyE2Tuxl-1w68)WEp-#LS@ZtxG2yJ<*}Jrw(mZ8KsC'
    '6&068E^JeR9v%Pn@E9GGx^E6n|8jVmC5NY{C#UkOUhkCBPEc)hS#Q%lPQMWY*{Rm6V>9MSV4xWpUGF7~ErD~-2@TQKD1D>fOb5My'
    'IVItP&dLlAG6XawZoDo27w(7A1eGgOGA2|_QMkT1O%4$u+AV5?EN{Zbh^EVCHih1sa|Xak8!7r2o;S8TcS88h<-`UJefxD_4_eAE'
    'Vzz;MIF|Pudu`BI>XqwGF2YzO0N2w;Rel5|icqiH>CNPS>p_X??W^l)pXa3PKw#U}Q7}7PYFh9$x*SN88-i2kckgvnMwcF#FNKk='
    'P`?TkqfD{PEL#w7l@GdeIO1D7DR&->GZEug!;(`kl<PKqQO-P!_Q5~SIj$4!Fecb1U~qj-R>BjRo-jH=j5x-baE!Ry;wp%>1anCR'
    'I20s!Bi~ej(uJjc)Z}gUEBA{yFg{d>|DIH*UXjjwX&zi)eeR$DpZV}{a0HPXCo5s%<U<oBxfe{J)~XK-y;Y&km2MYH=ZSTj#|#8E'
    'TbP8UT1qv6Z=)|1FRB4~By<!eQM$1?Ep#F<gARWrsddcr|Dc~Vopl$tO$!+0Hhr*uWZY{h-@vM!dm)1OYL3r#iOw-5R$??+!0ye-'
    '9he;^;jih%Kl9PF`2tHHo$xwII0aBuoA@8J2g*9NeMbFyaDBmydilMg_YvAC77Ki<%5?97GRh~T!k+6Isc43)bo=J;&5Og+?(xB!'
    'LkF^g0u!St$KWn(auy#FQmG*Ne=Q1a#$|j!h7v+1L-=@%ARjEH;(s!xi=d@ypQG{#sQ^Dh#5{612(flIPRVytO>&*{=HLs+`j-ou'
    'DgHWgov^}3d{-&8tW0q+`fWghC_9r--6UfLMpzoc^oAU4#_XxjQ^)yLN(;;R%&1|(DYeZpa-$pp=B!v%$ea%Z>I^4}R(+3&_GftQ'
    'X(3BcUI0UY=lH(E2^$u!+8Pf4Q;NIn9TLUzx^~^0)y9b1VYwg54}@{Sn3wF$!QZ=QCuaw*yD$E6cKB}nvEdJ|knycQ48;f5c0-m0'
    '^#y_p!L(3!w*}1S>HFh%X9sWIHZ;At=P9$nL1#1EXj|mENnT7&^wsrDG5j2?fpT^kVNc9BEbDMNpB6>;@@jDTNn_^=7X%_|)Qg;^'
    '0W0AoHDwLj3xpnXfk@PN*PD+=gSn_Sjl%?|XlAo2MQe+Tcp2J(y6$xd+jb6jQpa|q2oQ>$K}A9g2#trc-@D7EesLDY&nf4-XHezB'
    '+<0M=d4>9r1Word*0_3%OujNjk&~PzGnYfnvGR5muLLRh<;n5c;or|FPC*MOMqZW(3#A#=-NNwPlv}3+!fnHVDqYz)uTOr#h#{)U'
    '!&-^DrAn?Flja8_Iq&QACW*iMblU6mVqTrtIqjzq?`v`_&hzlV03Xy!cQ4gei}$U3QBz7#zYX`)$EzYZR3kTcRkoUS$34NU^l<BF'
    'nuhrPt2pg>@13vOPPh~CP6~Xz>|W8NDMF8{H)<8!PHEG6)zv-J0)F9bUB9%SE<+o-_XZBW{H8r@fROUAI(=i3xNWfco&9HoidEat'
    '+xyNJ6-PkDt~Ft<X0uUVNa~pEW{+(}Y6&SGcY@YKxu1S_f;V(=)hn*<Px4iS87F_A-U4$QHQ>Z(5}<-X@0d=9o4MSqMDn;lcE>$&'
    '8LII!G$(4M7YL_njsizi7_}={s3H3*1X<k#_<a+*>hA-BU=aYLP$FjF_Z-k40iYn3NIs!zp`r-*sz5gs4?nYd3=@Q=6$A0;@z=?c'
    '%bR|#Q|2H8c6{cW%CE-X!XyYbXDKntpJCQG@uoj^(f%0rS5#&zGoOtn#;35)vSK7}n&R#{y5&5INI^h`&I84z$Y~w%rNQXwqK8%e'
    'evV=wg^Y&1OG^1kXIQ(e@AlQ*a?p8@M>Q7%%W9q}jUlWqD#8?9F0sOjz?U~=*iH#Gsfs0DuZ%mJ+GFyy<|9yGcZeAv6^abX%7OQS'
    'its@O?G%Msvz{X&0%q_a<Y4=Kh2=~TD3eA*y-I?auv)b-nk|4%YoT2}vgaJ{o(Mez{`!(suZ{U_Jb&{nDbK@nZc>;f*ULpO$hR27'
    'i1NXDtgpKtCv83v*x*mR>`|mQ0S)!Q-eOnDN|7RfXAk)(7t~JQ@$ZgM@pRb5BZC1-TXzv<zGV53$Y3{o*({<3Rn<d_0wy)aH;NNL'
    '2%UJzo79PvuxP-dfagT2$ubAriHiY3fy=^8KKgmxVn<TxDnd0<EWJT>S}hLfEi^|j_8B$$&U)8NkYHKTrF<8g5R+a>OOgoCvDk4e'
    'lH!d2@A(vEb`v{k0_2Z#%QAE-(G6&!G$6*YrNny@<F`tkQk{wEnwB&mne?-gtRoDZy?Qo1|Haw`g~ZLOw)*(jlUcr_lX+}m<Y^w6'
    'Z6(X;1cMEr(!h`2CvhL2!%WBdx|^bt`3*iI<=Tfyg<ow@S%Vzq$w0~mJkf=k`s%(5oX=!NUEuuK<MsGoLpLxCyA$<@ltCj^nFydV'
    'UYLY0RQU25-PT8>d!ku%MidJ-4hKFnw~)XKXHNZcV|8H)7VMS1;ueFIfC6yO33746$u_Jwb=Ap+HDa?eR8wnrF>E~u(y)<AWMsE3'
    'Wt`-mgWZT0yK_+wVqPN~83&U9E3w4Dj#@GLI9Xo9AvT-`0FG7CrSmm{O<@JF47Xg7nriv#1Sxj9B;KsR1if6e$^T%>ncEe~ON^e_'
    'z>-PXcSpaR9iG0)68rnt_ix>wN5^ONDEg?-3AB#>vB7hkq9%qhP5MUWYH;+&@8z&dwQb<7`%SLbtA)x+A6)KJgf5BoqMlUx<3_#S'
    '{WHqlhYgtB@hI>(rY-DjS&5Zixj32>^IQGi!>=_M<olf7sSa|ih|QdNU($}_<H{(8&D^PU0D+Y6#`ds8yzz=T!*TBnzq^$o8+K7e'
    'O{D3Q0%xSm^J*$NRvZ4u<9z<95mYqK>K-CL9bY5QH$fF_dDL0N=|`DGV~rHv{xMsTvLciNpksP$wc)WjR;I&xQE>!pk$d{?x^W?)'
    '=cbS6j+;m)KJOGk0-Ij%wCIjX9+AVeg}Ih}YQE{XRhI+bN}~-I$K3?cZW3RrcO6M39!eDH{tSD|KdmM%su?Wx$!BG}pz|0*<J>rU'
    'TZK3;<vYvXJ>8>Uj$OiAE-t6k+glekH#wG+D>ghqz_b1AA97)}H-Qt;s>rzW`>oZwk!Z7PB7s(#$NYH+YK%sV+{H0a!o}6((!9th'
    'dwv=WW<FD@!4aQF2thlj9QnD;RjqEP>@`vI9@o#?k6SHg<7oXJ1ij>lfwSbAa*e!u`Rn1E10RY$$g$OMbx3-{mjwANY$J+XZw@U^'
    'e$w$l?2U9UPy9qA`c@uvN-ch$(j$qOiX!@r(p2J+LfGFd5*XiLioCDs(ma8sQ8gZFfx6}_?8-&LG-w_pu$>S<sZHwz+f|P<{Fa>p'
    'S(7Mw2@5A%s$??w0^4peAaMVhCzYu81vjtmd}gOGufJMJgjYtf7=46Ii7}h#8A05es`yGOGT)Saw~0&}*KMLKYouj)RbMC3TGFOv'
    '%w;hjKD_<Z4)Px9tO#B{*~i7A;P2AAlIo6OD)x6TE7RDiFX|$>r7qmH@efNzkJ-m}6>P=2#ft)Hn2uFiWe9=z<V;hkYlYt8#<jKV'
    'Rc*=Zj${JkSrVayRl^g#)#2Zd&bmJz9KAk#Ri$W>3pGowpuI7>1nSMItGE7!m5()Tw(Co}!VlMK>%$Bnv7@&-D@b@0i&Udrt)Gg6'
    'CeUKRYhnePaHD)^Ckj5_6^&fiP0HbB)%bl6b;&vv=;Wi>OG?MSpM1(Ru8+RqB!>=+aV7EK?XJ*X`zffRDF0rqt1cu)aqd<YsmzE~'
    'b$LmJ_tEZKS7#klsHAi)P=OzHn_OhPhxKUPetL}HgT%O`w-Z;)kcTufBXamftR&(!EA$+sL<oA}YbRHI?unZ1WR>nRR?je2i6>s%'
    'vnrDgCsv6v!PTD&B?PrZ&E$S|HPVJkd>DRc09x#J<1!Qu3J03ETxO7d3BL{FBPXg%Y6o)$)Yj=a$(O4Vc*Sp}%z*`b7a=dAjNNtQ'
    'ZYsooIki1}NLa<1l#S2qN@Z$^1><RRlYv<()va5paYf7=E#C3Pl6xv`Z}0pWQl$rnhXy;RDu&v-1f%u!yA`0$UfQN=cCTas_c%TK'
    'Hp1+c0J%l^;#RLmU8e$A+ffCTg8enQpJ?H{XeQgS^YWS433AS?U9pv*TaJ&NPNQ3sTB%{9&X%e{ax_N1y6avUrNaMhG-wy_&DShu'
    'NeBR!Ik~wi!Qfo<1%UzPp*o@~eV2zkb-fx@4!Pnmi6h+L7s~|!)HwN}u%+Y%p#~(r^#08IDh_w`2t5)ses0LT<bekxGc<L>sg|7z'
    'bi=y5<0@W87FcE8_^!&TJvj^q5Gos$3#i|h4G3HKhATActx&?4_nn+t<x~l4H{b?7{`c66C98PyZ%!POi|WtWjI>(*`#2uhuXw*k'
    'AvPK8gK@tU#luEWuv2S-F%+I-u3F{Jt_JA!BltBW4K8k`tdO>C3<vC`L3Y}nv6*nl1-oX*A-WKdvC*Pwv#~<e6F!gF^VDVsqi$yk'
    '3t3=70gW7mE~C?h@!5gb1*!HhVVz{%GLEd2aJ8q2T}_5bu1WCZjv2m-kw_#3s!<bCwpQ}<AgnX=N{Jwr>2&5nSWLAav4r9+7mnuw'
    'n+u}uUrzG8jnnXL5K%KP<;69ajpEc|<XI1i1(lq!++0kEvLe<I*ai=AzLiQ}c5jZ%MCj~Fq9xC7=y+;gb1I<T#38Wj9xnN4JZ36O'
    'ejCiECCYKR#y`>JK_G4t2sKieSDA_Dydi|>WIC+bhA7;}mU3K8oK#WHW{(VPqbMjlSvC&pxfz}=L!$mqSZFzsCHMS58S93O>}F|r'
    'WI&ZJiCLVRqvNx~Q_mO_B%tByTsF`j-ECR7;>?uZS1xClMFm&q$z6pmvCNH`!MRt!3^ider(L8HCm5(xEBnAkLRske&C3cG*2}Pp'
    'C68!aXy@c>H0Zv!Q(l3v#NZ@2S;R%bPeS1L^euU)Y^j%7J~KTpd0!sN>2RnvjtV9Z-S{ZBRKb!5hOB5KVJ@2FpO~V|utd#(yW`>&'
    '7{wvqj|1Ec)zxA)4A>05>O5HGf)wPw@`;{Lw@i1Y^lhR<Lov83DCrNQpg)LmoEDrgn%v2&W!YV=_8tLDE?dgMQF5W@j?ttZ&nQeR'
    'pCMyiC7?_^D%`DY7RNUUf6ET2qCM+ftTLdLL85dP@~N8B&bZ7AkGi3QzQZWm4D%D?|82ISmlN3Bb`xiV;QsXjP02`HArX5XRexxZ'
    '0O`W-9TGs-Mk$^6YR6Eka}C0+W3~kwOSihxlJX>q@)00z*pD1k4yPsw%dzS&39YHrfO()DrHZQ6VP25WW*V{8O_d-%G=yJX#7A0+'
    'J8~YZY|hcYdqZ*c@++n!L{f=E!>o$TFc~ZLjxy<m4eRM{OlQ$b%(?4072&VeMh6&Szcg5bO%oA!J@LQ1Fb2D3ouQ(F!E=}X&IA<1'
    'L93#hHJWGfdz`<1S6!YrzWO~gEr-gmP~%m;XuidM8`DDtgY?x=j)sdhQZXgh3YE|*h1T~devDtm{jScpIDQuUmNUUG$Epk*A!!#3'
    'a-Aw&++E8Wk=k5Clj`4gjrv5q{!$e}lEY>b3R-j2nAl3bSU`yU2HHA3{Q3PmpSZC7{?o?;_-|il*G@JrS=*vytWs?8v7NDMX+D?%'
    'gAi4ZwauZa9l$>YP_nq3qaSA!2-SDIYR<k=q?@GDqo{!5YCQPT{MT~27*O)_SYVVVwxD(hYN3Y8RfK$fUCV1CbYOMpqZQna*N*xt'
    '1fO{qo)lF#9z0-woD6On!k0BLsWd+Q$@eRf&nlRV<h&d#(TS~t&OZWh@~kv8dmuU?j|Z}tUjJ2Is@(nR=z{z2eh0wMqX``H$TYiA'
    '4Kg`tLDZO7MXY$`NPEvUKLE*&-oF1|#}yZo-mJKqF4o?yt7DdYoG~8}Mq0>{?Y-n-vfbL*m47s-UR1cDmq5+>sJi#@?;VNwO+l$~'
    'CDVrKDK<^DV>w30qhE!%KG52H`gPE+&Ztubim%`U&iuy1tJdY$lrYVBo`fJ_3ua3|6CKAMNK-Kfz~3omuOd6=@9YyD_@;O7?T~&i'
    '<}c0wa?%0KUc|iZhIjNj3ul}Uv`*Ta*dxEoVJ5~aZq5&u!<aXVfPHcF`t{NAFWq0>AHF+7g+ZF8w8bzIe>}QKM%RR!|CVxZ%a3W1'
    ';Y4K!odRVt98HE^6&ZUlewc_uV{hD>U)OdJoV8aJ1NszaV2R29^1Q_kG(Prx`txf<^L_d2(eYvT=v4~k&JIq0IXwF?!6ZOAIfA5H'
    'm}7VgR(k8xU_Kd)w-~m43yZ*Nq~aH{0A8zBSFGCS(g~Eyupm_Zc<;l+AYYP$kT!5JnrzX7)Owp>J(mlf_~-PJmO1xpXmUbWZOuyo'
    'Yd<n+U<v%odkoV9lcV{U(3(-3Wy8^2a)lu(Y+jpfQ8KP@qzqwPPtt6=e!kt22X^T2?fLezPM%YJ_$Q%U<KtH6hdlkS^ut6ciFtFB'
    'cX1ySetyX3m@(3M@L|H4(BQ{UggZU&-MEXDX2>tX+j@4dj$<>pHK96q3<J^bG<*F%)yETc1=K!+QCe05rZJn%@IN2nKNP)9N!R<M'
    'k5EHqlAFT(W}+y|h|!{1mO0?HAVS5u@|<D8u}Xc8HRt*HMY@Fm&|BJ(lx7xN%=7RSzTs}*^>mx=4|aF<_ICQ0JCFCaTTh-o-QMlD'
    '_AZ{bE_%a@L4W)4#s1)Ff3M%$9q#V$@3nSYt?i2^yZy^&ttXd*Cp&4Dwswa5t>NXxv)#S^<EMMWy=VKq{yu!Yz1M%X-P;*H+u40Q'
    'eEQ^auYd6bq>;z_`%j-d-MQ@VJid7R<gx`-Y!5GYp6pz<c6WL^`_J~D?hh`udru$twx3+?54NB6_a5&KFI%lA&wBl*y^G;)@3Pl>'
    '*4uxwGkmi5bho#Y-r>01dBvL&smM+L=sjbzfD*e|L)d)1`PbUu3y0$(s??Xk4@yq{T-MvNRO$QUH-`uB-k%=6N;CE$rVN=wqEmu-'
    'g<3L6MSXJo`XB%HQc>%#;}@8C7!OvxReQO~0WEnHZL)N`w|izwqsS~9`G=hFx#=fDdH%G$x4*x?v%R;X*ZM6sbd}2~+hnZ~?1)QX'
    'qZT<G^StHg!H=d1KJqVe%8A<RLzlDb(WJKb<jLc`%#>=-S9NnTTyVXQDDv*2{`{)Rxy0aatnW8(3gjamGA5etNrvgnOoAB&|M5}('
    'Amf+qhJ1jxM|V=diCp_l>-<gY{LR$)o7VZ8*7=*Q^EXrHZ(f~>u4oqOH}CBI%{_9heFf8h@D{DrGrIkqWzoykWZERMfOBU)8Wj2Y'
    'jKORStgf7Zb#(uqqhM3VERYm3(;OAh3Z8Tw_j;15>Oba~5cR`Ek{{>iP)cBT`L==w7^B?neZ)+J_;Us_C^UcF)g6*!=)38V)GXTy'
    'Pgd?o9btF$Y;8N3in<Bzf9c3Zp{pgwtHrIBkInNhG*w@SONZJouPL8p>icy{g%|0E53LmE?n~!6u9#l6&VG@NiIvj<<DB0(R_M!K'
    'r~V(UFFP&#pVuKc9B72_Z^fN24N&FK;d40inMKGh(h*1o6S#KLPKH;3Wgp7#mc_j4eTOCOK_2iFIu>fSm2JcMPet)Wb0z_|jsFC*'
    'zQd;S84N7uKfz+MPng|6Uc;j_jYhvs;TlZa4&h`e9r<aS`H4F`q3o=}e9;<Umj&n)NCe1XJJrkce7oJD3zUc$CuF{yq&gMU2$bjK'
    '3iMHMBw``Y4cOhg@a2=%?)JsA-jlt@!{KlnZb`UDcOE~z*xhgKJ{`b|!TvVfZ2JSa3tPK;dryb`-QA1J{$>C1#bEgKaax)gXUl!>'
    'ytE>d0>5_fS1Vo1Ul6TS+>3M%2)E-gIC<=%rP8A+MoKmhaA5l94*W?>75SP%1<F{tGZkU1P$$d>9r-GRr&X3-FUO0~3|UEeXS#$I'
    '7&xJdL6M4HE&O`p)yUHMbUaAgDXX<+qse5@Z)klDGmF8h$vJ$FW|mk0{zGATBLDsjx3=m-4vplC2Q4{teakspS+jTKszd^f=$Q;X'
    'oM0owuF;zYCGV4|PL1e>t0lu{w%0u!K1|92bc)6hGs7H0_OB(}J(uWh(D=L!ZHri(wpqr@(#aIwrETECULL|+f|QoF@xRzjY8xh#'
    '|Hx85tRwZ$D|n5YlowX^YU*xWEfA7W+K$kqBKCF%v*{(Qt`kT=P+}l9vq1f)<ONJ2nLL+pmG;Rq4K>CWgE?UUCB<OY!#`P-r8@g9'
    '>!nBuhsnx_)g6+Rl%rQ!qvRQE8yC3LqL@PG>BPpA738YKZVuDwIAKLX(@Omu3J79<>R1CVxc?2w$+_r_Cb(8s*W8s7T}-Kn%Esv@'
    'P2-{)T!TSBRoaH7e56)VrIMhQj7Qg_MNW*X)+}(rbmBSay`?_kI~yf}q4Zp3Dk%o&JSwh6GkT6&H`M?Pa&;Affj@FYhUDLgCp6gK'
    'R%|Hg;{?c!s`bPO{$Hu{9=FOL8<v&!o_&TqL7uyMl@%%_|5M_cZKf;xf>I9rnDg|nQc;yB6BjRax*&ODF4ELN`yrvl=1$R;LKXAX'
    '61$f;VoYM?82$v4H6#sNSG}A}4(X7pTAxnNbof!upV(KFr6+UL-tJ0fL_^Inb6tTA6P;6YMbjzTNv%*0EGbmL;lD`2;Xm=l<-b09'
    'F_{&a_N)xVf0Ga-m5LN3KQC1%T0wnwWq>vUsvtgE`2v1tajnU|gA=ui2HnCkoiKr^PeKYmn3mO>*t04Pr!S60PL{#AFL0x6gNg>+'
    'hLb(OO)*zKlIqR=fKxhnx#yfN5C}IM@mWI1rIc5GGN6<yBRrF9X`Zg!`oilY_PzcqRt)Yd%++;ojMvkk?`%BAZS?00ixYY_I)Y$t'
    'JnJF9k4)2IJ{Z(6Cu-f#=ztduw0R9z0__sV>0>mx954HL>j}2yb4jI+7Y^D;MsrOJQg~KE9n)gEAbZH|U8V|boNr12h+PpIo~Rh{'
    'jce!UJAockcKdbI&8@=8lRVviwv(uyE_z?sDaLt8=(^p)ckWz+05_E$l#hW@7qE2v?1uJmON~BG62INFoMVD6h*w9araHPFLOT`{'
    '0jXY*evuSvsqr#SvqZn96G?y2q2$#Ym}Y3Ifh$EOxFAOczHyC$!}GlM{fgILd0xwWXB&Ts;GkH1oq3b9a>DgubFPu6kDor>Ydvic'
    '0s03~@8d_1UXW9xMNdoa*q8t)az+H;MMT+;II{zMQ{QBP=o;O0ZP?8UtFCXh!O;-por1h0-(B@6XR^dJSl0A%+#6j(lhBsg*zCkk'
    'iHSJ26?gfy?*YJ<FVO{@e`ueTh@X0}dG$4=#H~@rt=4qkOX?T8$Ge~LKgKNx_~m#(SY4Td<m0k8$4!rq*E4>9J5@IC<>}$US;zzW'
    'DF_2UCRnKZ@(uUc9HQ8&I#1T{g8E^=3D&CUZq2=}_qqAh`Hf#&?%P`icVi7NCyQ}&NEC_;AOA+ix_kI{n0M#*@r%vKqs&4K`_&L>'
    'mE43U#>6)ji8bt&ktIF24>7&va>AY~bgsxhU9?KcpQJ88JN#%;7!;H&d6=<)4HJp-a=$lOh}TQILgMjjP%8_}IS7mW<t6M{DnW6N'
    '%ZbDSS{AFS=Xe8$dy1v6y0f3yXDPfEtNv${(UtS1nR!d21YXqUwVS8st;VxnW7xTUymObzl-AYSL^U%o6;LNNV1BVj)ueK3n9t>m'
    '(eGSInPOKO=E6wB+uNHDWSd}=*Z!SB45_xYm13b3<~1xqeb?6&GlMVLf-b(%DX}r>PRi<<>)6Zfbj2Ll8Wmz{HXV;Hzsk2DJkgke'
    'z80ja#@oQXs<rgm4wvA4xCNd>xAUtCZZr^%EaI=UQumpVUnD<cMTNcD%&(0fV4-&hKOc6_PX2Ou?2xSgCCpx0uW!_lNtn?^e%Nm_'
    'e7B-P+PY3Bkg#yX(iO8&Hm?Gvtl)N~iY;#zoms6CWSQsMVj@RWuj^4kvsFnt6mX>{DRtWRXGUvjjLUq$mWp&Ko;%%a?yshW%y<D8'
    '(}4WU@EK*kTvY`&WbEOKu;1Plz<UZ+uQ-nwjRdsMeGjMOPZ+_TNRbi8gDZ!DXZ)bgd5<u=H(WVn4@-*WCF*lwi=tm~!7#bKh1S@E'
    'GiwZMd-RIZs`keNC)Ai`WAt&(`N4Wi82lXd8rMq-_`2?4hBi@aHY=74wZs0BiSr0~kHFDUF^#qG8l>Ks>UkFQb<stoYS31_(#<O6'
    'SQI;Z8W_*D8phB~l#&_*3}jMhtzhCBh}Sk94ja?u;v+1<$JFI<OOrwAx`i1wr$5^d64Ss|Y|1f^*Wp=9HS3Xp^tLSIqz3VPdOaHt'
    '7DQXL&(zsnMxKVELlql?o5FHG+B!KKvaWd0r}Mebu7K4QDcBL792)>l7<1?vKI&n}O8Hz9%O@w3L2`379iyxJc${oMZ50XhW=v_G'
    'iz~dnCJgP4xC%}X6YaSEphre(U)W*SxWyIfDlsOAbr?XCoDlmqWdy#oo%q^!6*=KWI7VH>c9On5Jbne=q~)1PS<J&y=N<S)?Fii|'
    'T#>!vleiD23abZ1?;-D{WxPGD8HU?6+)Y<9gP3Jb1;^b8duHrSA*wDvsnu=RmzKaI!@Mp>w_?;^O(xHzh)?mO27lDhMQ8}&8$K2l'
    'oO27lm@Bv<?1~Y+Q(XO{v!geMr(F=}Ue`0Hltp0_h~tCTr*CZ7BGqxeO}SNCoA!JL#5jdl4JM%mRnl;HrPL;P5M*|;FkMe!+E5(V'
    'TjpZfXN(C{VF2A`(w|nRZadfNBtIoB2HAo#HtPWp7*18~;c|k}Jmtu}Gx#1(FtQxh40G>n6`gj|-w?UdnX^pW3(Broh)f2!D)PDe'
    '#~eDF9x%b_63A_VF+pZaVdNiqqZ9Gdo%2oU$*zdI5g4JpVK!)GE}V^4!qvX4US=Pw)Y~UaiWP9DE1SRWeW|sY<fXH1sk~7O_k|+&'
    'lg6<mmH+V<)3@JDnV}E=c6xjDwIBuDyR(zGWWq%pAES=T65t9@>qn~gEMe^&O4KB7`SxS3_a$y!)R0`wVd9pBMS!ua4~bTm0lFFi'
    'H%P`D)I%hyLny?7gG|nFl%YPL00Q_t5YCghMxsMXtu`gZBl0bfFdE8MZBz-*wLW{x!dcnSC=fTJ+fDClK|s1_M4*tw8D;z6X%aMR'
    ';XdC^r{k@g-u#;VrY0pLIfiH$rpPgwC$lTUWP(0_P2|#zU?LUE>+2qeB7e)h?p@jCd-s3n3TK^Yo{-aQS&<oKaH2fuYDS=f30P@o'
    ')|-d~4st+A9A=<&E3MLJF$?QzVOVn)s^zP`{<eE!m39|y1fX6?!6Iq_21OI0^_(6eb9Xr&;a-KGC83bBcU{BD$hZ%l_KN?p1$C)?'
    'lK_9dRaS9%B2STS`EwA-JAy`xz@8{Qa+O>3g67u`W0CViygc0Vc-1uOcQRN<@3572FKDVnvnS<@N-yH^lCC621z*E1S>D#1ba=uk'
    '#TpEj)C+_1^{GMEQLh><Z7e)eKg$y1ow{yrJPW7&UiI?sz}(gei;R7U*cMbI?xb1y^f?QtbIOD^g$sZVVQdvqq6-HRi9MR~(p-qD'
    'lU|cXmCDgmZwlFs8TorQKT<iz{<y{jtPa*_4%}(&J~eXjWsecPQP?io{Rnfri1ga3aJfiIr@TZ?%cE6Yx@Gr4s~P8S?0D|5qoq<Z'
    'in}$`D*bS-Ik@G}EsTd;_8lNb33l8K8Q{zMYAnxSef+o6myYZIBKG^6^VCMlr5*lodP8XqY)im2!oRG(aEjNR8aa;J)@tIqH>%W@'
    'cI%9i2Xvjb2>uOxD*a}qB0iCBcqR1N>Wi$uoB@;8^LY+yL2y~_0i|5Vs_TAo0iN<q2m9M-rqrA{BaeFm5XU0x-Ikh&rsCQLd<YEm'
    's3?}iEmW`>Mx7RCOV)BUcO|c_kjqbg%FQhwapV$y?A&lx9re&9`ANM@R)|kgHN5LPyDlBkHF5wz1bF*KsF-x)S&SCxO}W1E8Lpr9'
    'N5yPfkT;R&_h{ASb~6oZX6Gr{z4UuNvE_3*TpM&I-MgX+n~l#y+_%yyn~h(}7-t+V>b@=6Gz+O-n!0B;t;#o9I^5OyLF2!Ajo(_0'
    'XU%S-^C->S+Uws|y|IXH@1jNY+Ka`%PenkXUE4wG9X#5!vTF&_Cd<HJ5<2mKRC#>?vKZ#Zv?pO~AK=#%>KPwNX`A>CIl@g`e02~-'
    '(k-mY@#N#^;BQ;pYFn<{`djy0(i~4{BDe5-#y|o-W}MTbjf-+eq5;a<7b8|U$E1V6<;eKncSxPsUop3I2|)D~suMPCTTB6#BQ`>h'
    ')>AX{$7(rKan*~aKdY@mYtKBzT9$-J?;0ghiR$i76<-`(V16;~2DP(aX9EFPZ+7W)=yn4oSLKyd8WJ(qVt3t2@mK1n`W8zOz6r1O'
    'lDpFsCzC2EGtI{L0v#rCXNu<@6m~f0d)==NH$gr()x5;Lfc<60u>$AZXkbqp(|H4>iVE(;O@C#&E#1MDOJAP6dHeeC>@X!q%F@6z'
    'wk1>uIF*nY5VcNk37Pur;OH2Gca!ws_37cktABJ$?;>kJd7;Y9OKuD^ZJw(59t0mHYiUj+dwD>)!|u6sp2ujsQl$)Y$x4Nv@{+#S'
    'I8spw-_j^uil}a_wyw*(h~q58Ck`DRTr6-^9^o3g`aYH-k@cjMVF=dB7X}`d2-YG{e#lH9@2MD?o{g_`*9brm@d+5f$sEEhMzI1p'
    'zB)x@Y0On~7hHc%$M`c@<;iCRCvqx<C;IZDHwPAf&Mt%=V8+YWC+}aqI6Qv&Yxl*$>FE))NnR(FHev^A6Dm@SO{DwumxHrI#4t<s'
    '@`eH{{2QE_q<@&nZob0*MT)I*nt&$P4U8faq`@lNzB9>UxJ97@BM*Ax(*1}ko7{S~oI74Eo%)t}M3Sa%fiVf98aTixT)n;*y0qQe'
    'efng7&o{Ki-G=28SJuN8e9vHY^evf*;GuwOq2mWej9C<WhvV!Hz6>sxlyA%dvz!?ptrEs-6O%j^gzZ;@@l$X#SI`KcU5x+*^Ew}W'
    'S^qt5#s(MmD~Nha=(s@UR}d`{B)NjF@I7hA1CQmG^-V~Gj~I6X);b|M$!4Ucv_sun4)B7!uLR<eK5jvdLU0<nz(jdK0;~!y^?eQ$'
    '7<T%a!!b}{(y`7gFj<2y86StV$AOtd-<=vy*m;U?@G@$9nSB$IwYKo(IkTvpQvOFLsl!&<yhIr-jO!{1)!cuRew_5zKrgn6EI|~6'
    'F!-kC8ywBo#LcdaH{dxFkIo4@UD+w+sbS473%@L5*Tc+5G`-3U)nsB3V!VoKP+ugU(E@MB8g{Z87&$35K)Bil^6gyHxhCKx0oyeI'
    ';4(c*8|foLYs62hIu<*2Pv0NAM=sUA$!?-ia9=`-WT(#Z=|HP3w{JuBMNKNr$3vEIAZS(prDD8)Rrf*Iz^)cX<tKv{3{U9ayG=%='
    'yaBhg_I%(kLC!*471&L%NaB7-Zo$~qR|jVY-M0s4zxqT#;Z^im`JxgRcET)<FikOcIO_`MaY+ZsSTOCxRghAO^ao=OdRa_~F_Hu!'
    'YV6(WEf>=Qn!)=Njl>>@G#g0_g>me&hfbGb*f6ZGw!QPT?(>c_30=^hwxh^x7A)5J>_^x`@!}*8_;FKTi>5&pV1LWW@=Mw-M>i=q'
    'px{-BL9a?AG(UvLn=@!K$C25f{kaphpOnJ(T|Eb)?tM=UB?7Do#uuhpP_!>1yBaq}Z}iV+o%%WvO}$bTCPv&-Be9y676`&my0JPW'
    'OaX`Cs!C^MKxs_Ly&Pe;vN5@N<n(yvEJr8448`(701TRxJ+aG4AZpSGJCwk)e8=d2)=Z|<{7qH=p%W{_z-hLCJX!%ttn7mFQ6aYZ'
    '3gL=JB|;WrWtfoJd$Y>rqnhgW4Yi_m9gCOkY(7G{5Z4>M+tC@<39mr^WVSqVRmL4nZuLKqE9WNuFI)coZ22m``EO*cNlU7vA;b{g'
    'pk$FJ3!*ZyRv#1azia4MeZr|muW90cM5SOHQ&+NPR7aB-G`D)4e1uZT64?|EgFM@iM=lKkE99MK*k4jS*2|^<V^Tm9fOMhm4OjaW'
    'PBj@{$INBxhF;|sPo1(XxsZa4ITzkdoh^tV*VpN4?+0hHI6qHuwOsTO$j6C;qnpt`zaFI@KEMuW!X~9jU1{6Zo@(8(C_7P}aZZ|G'
    '8R;m18a_3cvC?uY$7U+SwY*4M*xxL<NVlouYvMn><}G8_RL8h}gFFDaKRiL&-bOQFA`hiPG<H`^$_lYyc2CJ*W9c9i4ob3thz52*'
    't0jPdsaZE9zSkPz$jCgkmELoF=qDi2kKQ0N&j_sp>3R?Ch%*~Xmfo!)9%}8}G}N*2!}7*+`N%75OtC5>o$RnKgjc~m7Jj%#y>^@('
    'Bh7|tOet!op~D)@H7!JSo#ndfhMieMO6;4)8`NR7Y`7k<S`n*e`4Vt>+ttCes}0i{oMaDuHaNP-N#YAs4sfj;0eg9EIkwT5>l)ex'
    'qdpDl&u0o$xkjuE^tGQ?`aG0MRyZ|ycl(Box~>fV?NcgxPi><6Y3Rmaoh6(?uGf`bxK(-)O9-JS(@Hi#nECc<XT@Mex?#s;_uJiM'
    ')VFa)gze=??u|C;g0p6i#GN9R)u#Q;d<0fG2RIG^WL!=4s&c&m_|H3UgBriTDyINPl-X#9s;J|ONgI9Yi==EMHtB3gt0=vxh%HoM'
    'b)yK5lIXhL_Pm)_cYv2d@+X{uq9WrivZ9!pb(~=p43OZZdK6Wm>FXkRNM2k)DXf5jD`{Mb1yE$>MeXj@W_RCat`2&VbBOZCq-_O`'
    '0D-`G>a|cs>8t|mVSmypq6lD1PXDlYymjGn-yFi=a0E25#;6&Wj2vgHm5lLdLSnKBy0M#8*RlS4$5kk|G^L<LI80ird*~b=)N0{H'
    'T3iSS*d+x&JDn{DCUTn+n5aJ@fr%RgCsqY0mZvcm338tp#czvK{FZo=jU!9~Uy6!w6W+2V$e4A30r!YKaXG)0Q7C-;Mx5m7rr@_e'
    'E9oool>ZgSFu5M|63f3sgBgP3sUr+?1-W}IVLoB@OJhFWNfk{0t*;BFiHG3)FAA=SMwA2rGh4dF8fLN5ExvgI%EBECqCIP@YxT->'
    'QNPFH#jS1H1k6q)_0(eu!U{FJ@GA19KT_s8HG7xuf>hnZmEJ-}$A_n9>MSH&t(ru{5KZvEVK-Mg4LPPSET`$P*j8|R7jyNi(lz@`'
    'pCOcL#dDUZo;||Ze!Dl*YM{U0#k1*Ky)y1w-5NvthSmM<K3IQ@KbFU32z`$xSA+Rzp$-E=2iJp$-TQm|k>f}4%8pvU<hVn!iYr|*'
    '0p{l9TUjY@Qu)L?LSiB^vq^Lrf2$MdJ-wd&OYwiyJM_N`rNHG&zZIpxfD~wDYd{J%f$01;kNXYC_F+J|d=+?<NhH_yU~P&4h=Gg3'
    '!cW1CR3Kbv-wW3#h)^4&54BogB@7#-jMA(sY9<GhuUel)*ui4J0e?otEHU#5^$(gG4~7f%NtsfJChFrAp^CNTVr#`p3c3_a@yz5v'
    '&IM8rrIeq=07~V}J+Mi+-3mNXu8smWs26^&&mbV1ifpA#VGU6heZ;?vS(b>dOBA}HaIN1BK98o$q8pRUzf0!s%~=vu;@dI`dd}X8'
    'pE|BNzKp&SDof_$n%!_rC~^pR!bC+2rtoN(RiZH>0P40N*y4^r{X70e(Xl2V3AM=L*ym)}q+zWh13Nn3Pbnl1oflW!nKHj6`>aX#'
    'fA?zerMA8228u{VcFuFdJrYY%LzB;X>1xx=;`utsPD5{ot`)A_!=Xl^yZgl6NxoZ^UyHD-SS<9ciVlE3Z^-A>1Mr)vd-&T67B6h!'
    'YG4k(OICyC#a3}(l>_48srJbXO^Hf)>B2f$G*`F{PE!PBQF$6$4~&rIydsH{SR}0UYA}Yw)~_w1itW<ha2eZR|18<vezyC#wOfi#'
    'W^=d*VSd$KYEWYVuiveuM_!C@8TsidU4(Oz8C6wcptID8pHI37bQZ~GO99La^-x_8Cd+?Rsgq(=5^f4P@*bH6zFT#r_z=AdSfk})'
    '5Y=4$DS2yeOei{KcTGIE`gE+Bi_?MVBGp_oIi^Fd*YCU4A>tzp6;2AQ0L_mVJ=oPZm{6Xi2<{YCJpsBP#+*)bxg?q{vxs^@J~VKy'
    '4GvX!D`Xp8O4e<y!V06U{X|ru(`Ob*mH-!sK!ohP{o$%W)3-n!(wmLYE^;;PXOc|dV%q;I92Y54^AG@P-Q>!5^+x>a{qE@tg=~|!'
    'X2T^6v_6PFM0=-_S@;e}Fq{|epR)v6vePPMfr$s~_a?;+u|1f<Jib=emlGS?X}N2?i8`W$V(?>hHDN)}CX^h!Jrcnn9=1y&19v-;'
    'n|mA^<TuPK&uK)4vCHYrFlX3;dGy%=PJ2D;5rVk?subC`s)Pv0VF}z|Sb1&rMuNMR)a}yC%;{EE?nhQ`IE?qu2o)rl^q0dkv>k8B'
    'W8l;u5f8zA;>GnVFotOFd%+HY&xz-#{(PmKN>j62rI+(ojji-@jfy7t)J<Kk-kA08uW5AM`-oT}LsOZT+J>=2XpO_&a5<!NG14tk'
    'Y6hxLn}jK7zmE-jkJvpTc&NQ6=Ytjc9iO>_KGsV$nGsVz)nx^fCYInw$}277IB&IgI_#>5q(;_t&ff*1tu3|Fx#!xLFLyhR{?M;<'
    'ccV(ZF%#}}T4z^N;iEKidxqYz*7%%mQaRJHT|t})L|qBr^%e{025jSd__PE#HcqOUDmaC*j(;dhc;LMmV4QXQ0)^j3xnZSeok3UB'
    'iqI_+EqaUj6usdY%@{?jAi8CfH8zz>NKzf$+lz$-Hi7~+UWvog?%jeH@U;0c5q|0V=$K^=;;5C4(L<?Z^l<fB?I^yFc}+VuFs+QS'
    'ilJ|^`5|VqK`nwQNcNYFY%MXH=7v%4rOtXIcJEdom53x>c^7BV%U60z4aX~r%YwG923KD#-ABaw%57#QE{_c$5*u4#<D(EVVqdCf'
    '$?!LN3`UAX$IhonLo(=9j{DZtK<FLrX(7<FYvcQY%u~Yb=t0Kwu_f-4TXYXqO^L_1ZPvG_-BgPE92@as-D*2=pl)h!Knj7vD$fIL'
    ')IBV|RokaRnY9{z=w9#@&Su*XBj~%xz8oodKYs!W)fDa321k2^3U`Aq!~7ZSk%AdMI$2_VNG^|#n?hsV70)S0ScM#!r4pgqS5^if'
    '`6C*HelC0uF=~dtS?3_Y^~JxnY!W5^t6bU@9d`kZTtJ*k)SCNc@T(ZQ;rNgW^k>M>quD4=e2t^zm8+$k8k+2nvpK<l)$L146s_+_'
    '7hA7a#g(SBuOQ)19w&{Xr136kyhs|CN&2X`0^)4`YdKw@k4As3rwK7iT&Y!yVi@v12+*0RR86y(b1)n)X@}59XnIp`S4#S>a0ew_'
    '!Oo!5QHpJ*`|32?)qBCK%eWv4o9w@3eK-4#<DaW5^}EhBP%`hjBV15MM1=9Y;NVfL`|;j}z14K!^woLCN-L&BkRH6G782Dr#XlDk'
    'QH$!C$1RJ@UQ)EJy@&l;S=|P6u^bLZm*h6b<Y6>#Mx&I*x+m%>6=Klari&be-;B9SBm()m_oXX8m?z1JH1C1Hg*CugF`G_`fm9(0'
    'GfkW)5O5CvzivJvIxwsMV!aoSG_Lt7C%A!qLm$-5Ry%n4mr4mO&YIc%QO%ceBlT}Ov(2G5n-&Z7jJg<n*Rfq;H-ihI8Mn4nu$K}*'
    'S#7!cp8pw531Yz!2YSBKDKW102C{DGos!LzwmYiG-k!XR>DV5nTjY!wQTRxBp=$@S1Q$}{qi3z)b51dgy@`Rm`ggzER9qap4?kd}'
    '!g5w}(qd!R=`^ELYDe_8nK$6bdG-Aa!V1Pf5Pyf_mukt*iV<t=g(4@>7a<+H^;f#@qF!1=c|7sNfmgi(a(0dOv5E85NX8X-#qyQc'
    'D>0hpsQ&YMTUj~pSob@zjjBtxZ#T{>t;SUic!uKK@!^zq&I40&r?RGqbvR#P8?HxTE7u*m6*;S&@}{HF0Hn3`*T2nKA#jKDK8vqS'
    '=%BFja1~;4)XTX!H4TXgSxam3{&B}2(S3wgo!rtlo6YeWeNKJtW|v8=ysiWs^}pBU(Le5d=uMqtaqdAjQ(S>Y1^LX^OET`Nv4+I{'
    'r{vYB_i+Mj!sybZ$k9Dsh^rEib#I35b&DzInZR5P3g)>9r!eHnXlli#Pm3=L0n-szPTkArZQ}Pj<;=%%gX8b)tQmTzMZ7k<zi);q'
    'zs?O@I6dE0^to{IPa#WRgSr3QCIvf&Sb})d_z9P=ZTt?gz<HZpUCuu|U}OqG+WPRIQ%(lP$FY>4`p>u9x<s?yydZlvJg2{#2lJ0h'
    'bf$hwZ)zA8G#^ox>%80TPcOUO3<DCcF?Z5j+<MK&r@fn3_Jd#H!uVN>dJQ5rcef`k)jm9EG*o-^;Xy_?$@yC{sB5A=Hzuj73Ub!O'
    '@9*=GjfKDOm&`GI!-o<((|~ip8||9UM#U5bp9aQ;jxGlUehb1oF3g7q2mm$cE|495u;K#2D;!D>zF<O$(PE6wu-E7yG#M<=gFMm7'
    ')g^|+;Y4~Yv5eFf9x2!Cr#gm3Q@kM7$v8u}UM`ln>p=>=94`yJo<7c}O9L-}UzEoRJ9#)BeY{#UFt)UEq$}%?jyCl8YKU$An<|qN'
    '(#BnlCbQ+@8`eNpU^1m}5MUVR<nhubXDREN?B+JZ;7Qa^&W(XvBI<Zm*7STb__BcVgV{Itl~QNoI<)b;n@H9oi%TrTp}H%KR_;wA'
    'y-u*#rngmO?tIs9M*AJqjzQB4N{N^Bl7B6G^B!V}Lbq5EfY8o7-x!dsxwrVG+XK3a6OFm9{NINMH5tIyt~l-Hy$ejgTYs(>E%~FP'
    '6Wst6TGNjPzKZApW^pvco@w3|tZVJO-SkGV&aB!o$I1xvLc!hA1C}CxY#fiP>L`H1zq1NSsaNs+6ZslGDeO5x|6nx*T~F~aY`Xc1'
    'CX#a($vKYRXkKGYMZNsJ6S!DmzLQQ7YZIQ=>^ROxy;%{rdgY{a*}8mA#5=2nb*G!CO8zJuf(`#5@<)Q^BBpioN{&1=#gd<@RPNR)'
    'oU$;=F;<s0d~FC+zuej1y+pWRbXILAw^Z^Dml=8e96>UR1(5H&+~dQ)ADv+o-TQZkubAC|4r}-i@-ZJCbh{LP-u>`E0RzeX_1#xk'
    '%j?50qeYFlBW%TRFwhXR{=f;;&~fjzT8NN@(H*m|58BCtKmD+^EaqDvV{Ktbqp0+uCxoJK_yzbA)I~57$#h5n4NheVL&Q*?Hj8{p'
    '2{sY+bnCBgl20J`z-K6wTn@%#4p&i-1__8!HYvmCzrEcICTlXyKK?eEWmmo8YCO8g@Qlf>k@cAt83-cc+n<rSA!CL#L%Acfh>{u1'
    'N`|`*7a~Iz^uvTQbz)axKR~@2k|R&xgz0@me?TgRu8U3?WJNwq&JN!F1=lQ3w;w;<?+x}^PY3&#!;7bb$HP|d>Hc27*Bd<BX+3*9'
    'eA0S+vAg#qm5+`O-W<N`zWencPxs)f{l~p$gVxUF-sO|Mr#ro8PY2I>tyaI^+J5}_^6|6X-u7Pq63&PI{?6XT<ptFJ?CJh+`{K#7'
    'Ay#?t_HCX{dY?y)n=4p^!MrhEeqmM*-f~iVN*C7$t{ax*2u{}i0D+aE$k#*z97wn&u}CcQS8&0!lL2sll6eo$yvd*VZqtvDLMfv+'
    'K2=<@v`GFBe8PQb5cMU<Z7}o?v|aokEIS=yb+sQqj*vaa*q)!Z98$$TQ{m>1)bpR3!x@=5U}5@vCsCqRc2c3Pfq>oMoTSLKfy766'
    'zD=5f=?t;BF-wPXP8@Dpu=lnZ5eu6cRyQgXVU1&@usP~VS_t9|dPdu+q%kov)^dRt9Df2+0n+5(4o=^6-yFRB_2~GJC?HS6!7jF2'
    'utEEcr%!tOgPqGX_~__Wo<1G)ks9`&3<l4hJk=6^J$e29O}W-CR0t<szZ+C|dicxH$#I@yei3=}>hSG5c>em}?C7shM-$d0z82}D'
    '(m)=iurgZF(eYmokIzm{|FNz%op9h2F|2J0B6qxQlJ7rENRCQgiORY50uG2nI-F5S+@8Tpl@cd|LBIAnyC$80#G!p|^KohQ8@1~?'
    '7e}qkMZGO2u^cl^R@=af=GEW}I}_IA0|q{&+Giw|z>lT|9MtO1sr{J=6G5!7OM#5Y^I4Y8G!e1tCFn9syo~Ea-XI1K`#`so8vI57'
    '&fw5%o^(%NogBaZ$G_?C<CC9HUcWy1oBld}@%rTDU+P&pzewwFUk&NHC~~X}kHy-siMwJlt<|Ng__X=1d-M+IqK0==7y0BmSy}Pd'
    'a@5ar2A>`*5qw$|Gp6i+w5F~7{lt7RfhGEs=iBxPnrnaD-g~&++S#T55M~~Y-UaxX(~fnf;<*BI6LfRU)b(gvSFZ<CJj*`Qa?E=-'
    'd5sja{pIzn03yItJl#)&uLY~C8OUSOo3P5c9s*H5ANKQLuK#vw=lbR8;lUaIdHDC2ul)tcTGKsd{({9D_OtXx7h~AG!O(2NwS5jt'
    '0TSO8v`ee=b#m#h4%Fm!N8_tY6!7Zk^zbEaIs5{7LR%SmgQ!-?XjSMjV?oW4dIiCph=Jmd@d=!FD9MPs$WPl@$`EiU3Qs2ublXeb'
    '9=-C(_H*u`dmC_X!S=4i-}d0QnJPb@w>m%M>3^kJ`rGvSVkCZ})Qk{Cimk8$shvJ@THb>De(Mu(EQ9eD$TI!u^%mN~$ywFwgW&i*'
    'O5yv@2-eN>!sO89ON2GGux8g80?6B`!h?gJ<T<`QPmQWqt?=|VAbYu)(94GK=p!ygZjSo-V9Y9O<Uynz?^)W(M2+otBBMb7&zz^o'
    'KQ)-6N@)x^|7c$9?F!{%5yB^hQ>&nUXV=Il<*mAfJ%qmfXUHEB88Ld1z@Kx9%;~tFZxY?|Tr`pSx+vM_j8q=#51Ck?H6WloZ)G;H'
    'tvBWzxx|jcNg}<Ym=iVd<9Dr29WDv}i^Kqx?<P(VnvFr@d&JyB=|EXy2k`%B>%<Q{Td9@h7NCP0XjgTLWv72d<U5{%xMKB39Vxp6'
    'V8_(|Aa&0Mx+6Adzh%1_9gC}1HnZB^q-HndpFgWo7L%&@!vy%}(^uV}j}BkIdY9j(gz*fA#U=VW!@rC*E&r+&hJSXcEM^lXkahTn'
    '6mDGsh}55p>7q9_zeG>ng>&o<nZpy}JYe0K;l!~0e!@tE&E$a88L-KF6A6@dL?y=CM!*0#D6lG{e=~Xwu8r;yQ4DCvRFQld03YV$'
    'kN~D1xF=#L$U4!~sX2Lj25jEJYnq(lyhqq&z;ccI1YgTd1v4Y9z|X<X!1+ZlF~kDK{_61OgZHn`x+Kfs3ZA?_%eQx0EgZ`$>8@e7'
    'bsxZ_@UVb+zM8@q&kj%DBtx_-B5zHBy2%W#LstFZq+)%I26Ut$9Z6~k=<@3D;MHqj5IMfmXpVromNVEDFy+I+oaYJVek7H_w74JV'
    'Pj<P(C>uZ%9N)>FbVULJfdLXkP_hN3J)3<^anc2u2bKqJmK*(qwP%RyY=k6Y{P?{=<`F}A!R}n}-N$*aKS;(sbZer|Ssvlaanj6G'
    'C?!yDQFp@Nba-F^YoN)GZz$VAQac1POWrNvQecru%xguxiFF-{ew!*2G)1OV#Iw<iZrFwAZqR44EL5m5p^vaG&}jy4qq+}t<`7pR'
    '7<U`R|K9xTmX*R_4AbSuD{fedCAIyXR-MU#;JmP2#^HneDXBdJMyr{;ox%~H5TsVJoz!+(J9`Zfq3}!Cc?EgwZa;p~YVIYpE6xs1'
    '&)&c79w4`NaQyNxhejSfV=_3I40MG_&5v7c1PepB7&m6Id4<eiU|tc01C5wWDZR^24Bg&ak{<+6!eD+)ZXD|TKr8=GoUUf_LU8{?'
    'fJR(<j5mgU$UKRGw6T~rbZU4VNp!|ZdLB%}yw!T#_-Cv2WY<o@erq>@i9}U~sb!kXFO!SG*QwAU)YXDQLU$h~FHhe71Gf0lYk$6o'
    'c-)cDvWfayD_1&3x-J&ZmZ|MNZOH(T4nagbJa~8Lw6Kez;^>^jr;B|N>CU6l=N~4AJ8o^I6@L_|8b|bcIzb7KP*)f;Dct3>Ja~Lz'
    'nq58HdY34G0zK})k+z(}-bxOzI=&M8qYIM&A+Ipu5cAUcnBd_x<pYc89!uE`4YT#;;P3vKyH95>KK4$wu-qeWQuNHDGng_G-5}-k'
    'ryqT-g`U;UF)dVT0Q0c@2A-n{X<sg3@h3~f+?>OEy5B_oF(I80ZX>FV;*z9rZ+z4HT9Af`)2@7&5Tw}O4$fZw`s(DD?wf<tUyhFR'
    '?WZ_aWXQ13UG1~FYSx_Viug}fEIQCyRIAKL_Z{0{^qz&e7*t+LkDRJ4sH_Rc_~PA3k7AwAoEoA9L>!X?zUvgPxwo=2u(KEmWk9U3'
    'F)2;~1{a>>a1Wpg7B2z5b;K2!H*J6I*fO^-K2aeDO_HP6T@fLPsdg(8HK;BI>AitXsih50lVY~a5?175knFXZ%|G{*FHdUlH*L4)'
    'iP18`W;2tNP?j{9pd}jaVNYFNO>u#H32Y{G`!IW38$zFybSh<04x`UszCJ>xf-H>To}w(XWW_JG)~VOi`k!mz_gVO0YwIy<57^Ja'
    'GG{cUh0#yplNxC)n*W@FB*Sk*J%-eSincDQ?Yg9zB&CB-LypRJIvF(RAPO~_=+fFBY_UlIB?b`u$m#(+EVFH-=24&=Lq^OD=g_E1'
    'kZG^D9F36e<~W1Yq*Fm*!F6u$-DJefO5R?|vPfbMiq%{(h~2v;t8fK=@E+m^6Te-j9Z!Ga+Hn=<?VU~(e|Wp`tb>(w9;TTTjhFmf'
    '1i0l=`mvMtD`o9_s3#U@GBl)^gdY6Hh>fly0M{Uw+FPBBS3@6cgSd|?k#qVg?Qo`xlG|=EWz0sCE>VY;sEM)z@f}&k?oi5Gm@!Z7'
    '&+ILh%FHojT@omNj5i`m!}DD13zR_^7uul}THCTFnzk9YgAuz|7>jplOaReo_4H9@{NYaED$dI-cF^fuzDf<%*~uwEHoiMPc>C_x'
    'le6y8tJKUl(5C*GrRKiGPHc^P=p+oYMkkP{ecDMyjZ6jF_<2>s9n+kp8v8`F-1B}{#kd;%49)^J_S1#IN~yNT2ryGKTT)satq9Tb'
    'sFWjx0&TgXnO)?ObVJR`_^p*JHMEzC=y9h;HX7D2r+4S}n-1$f+>-<Pv<_8#w*{vH6x2e)A98IcGg#t0T$&Bc09%U;5;+7qaEXDZ'
    '(OwSf?#_iTku&<4Q=OuONar3yagy<AK+Y_jM;rAZ$zK`DLR=CBCkTDN5Zn)z3F{+~NK{)WFN;TsHRd(Qb%ML!#tqk7^w5i<7+o(('
    '5hOm<$=}}mS|=$5$0@uRs!By#Sa`NW$5uE=97_`LY(JkKzWcR{I_d7)*9R{T-y9yF<#cX26w8G;?#vjWM!kNTl?sVP>;3W3|M&i|'
    '`(G!()}}*L*{5}vo^?D#*hLMq<z+F_RvIqN1AT|$zEL`uCC|{>PZF`rcCXL639SSzA4N5FD+$xxWr#Q2f@&^M>vZ#MfJSBz{azVl'
    'J3LrNU-Fc`Xi&3_l>Bai1wq;-^&QfHrcSG|+DrU^5hkI>9`}XkE=wwNsUsuE3${*(n`>1{#`E;!2$e#O#stMuBI(BT;-Ao6RHijv'
    'vgRLG16BW5(;M1ukJ2{D%f*&S$%SDj*lvftKPitW=IMm(JeV(Pt;{6RpvtyV;km>k8dacd$G0|5T^+I2!|svPd7^NCKA+wcdFgS@'
    'n+tdP>X~!uAbtZ)w&+bwkJ(GGwz9uU5EPu}=Ewuy9Fw?0$B2q(?j+joW;!4D$;dXQ|H8WCsR^7DF|#$eX;P);wBzm#bJF0=5#Jio'
    'b7?slqmIQK{b&+JQ7JfDye*W}40b5*7E@ilBv#zsnXR&7|1#f4CrIpUkyGHZcRlNkK2B8RC_Diqk7+7hVJvs0lHkaY>#kBEfLDjY'
    '!*M4>2bR$##<EJl;8co8SlM3d$J~AQV@Z(DVq#O>tK1cXow_~AEusVY(fN+s^#s2(P-QGB5cjj_csMJyyd%}cpZhFff~c@%bV4|r'
    'YC$BOC@MTg2%bc0q!DwK_-RS7P5)erbUF+B>25N2#O{*I4&nB@+CZ1M=NkPttNPR-kk>%7MM<fvd1(~uuOxuuNiVFlVG2o`+nZTR'
    'SxwVkhwN}mnu><|k;ejRt@bbw?WYEdBx*TC&Vjc9i4S<O(FiBvE6VtW3)rPY(zqLz!3>V%t)^oz)g)1#v7!D$bf>adX}@tT67Y#n'
    'p(Qg(Z$5}{XD)MAp6IF$X0h(cy-@C37Sg1hd=>1urA&WTa4S6b=w^gUTrJ#YS6tEGLs`Rvi{qA+H)2dUqo6rmFIj?oA2oBnxPbUr'
    '$67X<gzpQ95rSgnraYD(M?s~98@D|OnQ~($LuZ{d)<G?iSsW(wk*W-w;tM+#=A{>$wN_Tg*z++Pq<IQAFFx~2d72yZDreL=s}b;5'
    'mebm5|BL{O*JOFh%yiKOX@$!*l{s`T1|`y^l4&!r4wi&NV=NK|Sqo;|hbMnVhfpLysxC#g6lBEZ7<+>@R2H6!<qXfpVye1eG?bLt'
    '1BWt8R?9}MA-tGtq3vvKAv$HCLUQVH3)eHa6NS52)zssbFKAr#W`okiyc>*%7&K7;mEo!A8iAk7fP8H_aHe#`{&RYfkfl1{5W)du'
    '7M#MhcmJ3pDROsy%-uKt_HDlz<5ze+^NE6N;TiQMLu)w60fkE1Y*p_l3(UrK^OLOSoq#{qq2L}Pp5%*iBDk}@ka!X{TIV4G2Sjgv'
    'q&IxFz}uhlZF>ZWjD^LvsMr?uB6bRJ0%>~$aEj`U_dgZ)H$Oj;ozFiq%#OJjP0S>-Na@Y7z5UL8e}qn+hYDS;wWQF^Qd>Knd!EOT'
    'I5c?r5p{AX>qz8H=7ZG9Q*Ur)vS=YkE=xK3DR0qSjc~5?V{f+fp;W0qof)Ii$aAWU)gjJM%kvm+k#paBqf>D&%~MBFYya#v+l|g`'
    'E8E`LhubPzVcjP_jC{fO$;jyx%}?xXa;Gfz{wHU)A0j1Jmi#lmB^M`do{v_C7f0QM?hY1B60<e_l)O|a1&^MiSIi*IZ=u9p<Da*f'
    'd8n~ne|R(MFRmWZiagrB`~S&%6RtM0EJ66ML{^^aknE6<0D~=6<Ts>E+H~5$0M4pvStmv-C@mzlLf9rf{_ped_TGK5NWw{1&v&L5'
    'CyIFS*8A?hwC&ljq1Yn%02>CM=XZuLgviOs(D8YAyZ%;;sd0%pupxn)ep=IeW-wCdk{3?wb*@}<7})7JII?sCptp*~(|ONQY0xpG'
    'P;`6c+R@I_kDnSPhtBCI!T(B#MZAuRs`=Pgo@6EuJtT*H892ThVBnaeOSlI`e0;l1yToKQ17$?pY|<HQUCxvqIn9>gJ%!Uq?+k0X'
    '0^0ACXO{7(lrp4uGvWyy<uee;sLP|X?e#o!do9vKnE!VMb#rJL2Mg<}XK%publx{p#16ip@ft%P5H1HO=aKf$t`J*hV7{Co>`V-<'
    'C*m@Rki7gcSy)V*(J*nEVP0RHVi=*qpPJB!k+kq&R#uVW*k6>hAyA9ADodce3;Q>p$9>`xeh(8tsMKhf7L2KxPdMw0?gqk@$c{-y'
    'EZPlMFDIv11vc6m1IYkN6b6V6{WcH4pM`PhHWt%3BXvX%Vy&%i59*fPgpnxzcC3XO^`+)YkJ7Zp!fGnd43Af1T>?I`6@CWy=J!FP'
    '0Z%`gfA;V-7FMYtjxfKQ_{_QLfhS&=QQ4T^;HP09GnT6vjEO2%-1jQ=J!T0ItRYWuv*<GAW{)m%;`v6QI20@sfL{o1*2g`t%7I?H'
    'E#4N`7f^7hLL?VUd&C$nneXCsg8hrcgXT9u7lo*cj<#K<FNq5=r&7#rJiN6B1se%-tI}b?Pw%=^H=Z4Q;;9F7$B2ieG(cM(Xd!Wk'
    'p7?0T(;lPFSeb-ze<c|z1}18C*yy@9xDP6`dBECRk$qeju8gGx1t_Dz;NvKW)uu9%-onD-2Kj*X2V?e}m#0jGGwh)D)o`-uhYxkD'
    'z}VgYW`2?l#b3G=tL%3!Av)S%JmdgK|KsSM3^U5qb##7igPmR;pS;C#aGr_R$a2T8l9%W2lh<dz9bcTDU9jmU%L$8R+6+@IRm@ng'
    '2E*?@Gu$p%l+6cSTn>x)R`-gR&#nVim!RJz93ZYrX)6ey!k8c2dF9N0FOS}xADz5DP2Rn~Is&mYIePW(<nj{De@#-CWm+Ep<I1e|'
    '=&ck)jKiJP?P3Q*NtXt;cj_F6uoFJ@PNvhU0U_Y1v1<2eShx2z7nWWyFk-%w(^tp;IKGU{VGzl<?JdBv6BTkAMm8(x==H_f`}5@L'
    '?CR)ktT2Hu8*DWt>Iq#L4J;g8<-61TZ#BZt-yL22n!I`cGk*=;p1g{S#Ty5qk@b(Umk)wUpl}-koPsj;s)=L#udpQ9%j^6b2u#`n'
    'a`c(fU&Gx6L-Zy3DibQ8An(ZL1VG=&^OILQT$~yFLC`Qm)W_<t-K|7_<P&n?HQ13NsKj^|pskaLkM+{!gaquuI&ebMWQGo_@6N7{'
    'leb6j%^t_gFbr+zGDj>+nDS&!k;?P5Fc=v_npGfjVT3V97rKz{ZnfP@!7>^wVu`eZd*S%m8o8I4mEJ>cGQ0-$>pw!SS6&vB_+j=)'
    '0f&J^9F_ze^7KnW4p|B0A_jM#QS21Q_7y|{N{^WIwD%btZ{#iZmWk(tCOV=sj_vO5c6k>t7V5S6=NAb4g1OK8zsHk#{b#U>pPXSQ'
    'yi(q0nVAmtGWSZ&jT`#WU_~>Oh9$GyGqe1plg~-}HW*JeP*`Lcx|wXW=nsJV>5WHqTURg6be6O4FGrth7_@I*y*WO5W#j_D%miB!'
    'VQ26}hYQk?<IaZ}F<CM6V(sK*zLe@lFYZG*^UTgs9~9q54h+@IF2WpaPgV!#1(J%3<o~||LEAb6w7n_tv-c=bn|vreiQD|Iiqq^-'
    'oTiX{1|VSw!X0zS9!n5*+wxl~6;riIjPy_DA0;CdxnLJYeu^9le@itAvXO@1fFUt}H9#Gde-y(taj6uRDRD_0v*{2yv@5~opanA$'
    'QqAx<ejft4hPwgW4&!lmjlX4@;zclWyhc0FKAVq~zgKk<|7JFl$|rW8g7ByWV#YZ(*eYM}4EuEXY1CrNNDxvy%oJNfi74gA1Eb&B'
    'k&*c<su|%Z6X#l7PoB8Ygh!*?GcVNLJ<i3<+iZq@cN96#)8o-y3!q{WT%0}8HV{N!0MZ`+GbD|`!<4U<M>X&I(@{L_-S&q@Fl!Nc'
    '9gd992Y*av^T<-@ND>0jAJ_5+?m}cKFMj}Vl+054HQ--Wf3Y+=PaX&z{l=-gp9nZpTt!tSIY)Z$uX{V9Uvi&lYA#W*<jDj^K=NHu'
    'I?Qw67cs~Ue^*<XG{W`Wh|&mWE>TTgFiLrd)o=>%N)&R$Ht4VA@5qbghG68+DwdnQ>}he})MiMr=t*qaJ*+v9ONQaq|53?P0*B|y'
    'F(6FPi!sk2L=ssa%v&jrFT+;_8K!R|Q&k25>fl9}(EDsya**du1CWG1bwWiA%*De*6C8nG9FQ+)L>|{EL=-lll1qjXVmgg*CuCm;'
    '`KUv3EVMQo2s1=dfz(dgXd)uC%~q$4g)#zb#|(5Cc>{(W`5!>Cuvtd<z|varCv6`e^_J87gffJi^M|Vmk@YeQ{DQO`@)B)*+|F{L'
    'ZcCx2Q#a>Qe|B;5`ou{8hKn+?_%9bn$??&}TdJg?2R2j#hx{-@4OVQ)JnVFWwE@1EE!4i8ZCoZPo4rgSRtuI%8Io5Nx2=ZBU{>?@'
    'WNE~_Cr>hq!e)}>_~Q7tljFZ1gIWIg;>d7l$;H_j3G&25=Nnv}y}x*QjQOQ9oO3~A&{|x^qCHHjWlcb#1eqc-w}UpQly5HR?c~+*'
    '>D9^AKa=yLt2a2X?0q%b@*w%_3{;T1p8<^=C90SJ%_{qJ(q)d=maGfnf=6kaq_QfA^j0C)H$V@Df5Y`pAV1k^9<Ut$^6d2L;_NLb'
    'mARiX7!oCt1@_Ewcfu{SSZMAyd&Qkq-LU!k=Q<NjhJF2B#-ClkN>)hDF#48|&yv0+qy^q|K}ZQ(4*Te#LK{JKT1%RgKr2P_mqM!<'
    'emVb47nDks$0e%Xn(PD=bBT<^!wlO3__YW{q?iOH^}HH!KHS*d{!aLd0cw|~3z3Li*xdD{KrP1?L|NSGZidhi@E6DGOg}a0Xk_Nz'
    '=|C}?jmV4A6^8m|UcNWm{@cmr*+mdO_4}(vD3=QJ0Pu7JfQncPzzei*z{}s$pLfWvMV-uV)L5c)j>_qZTYNPF#Oav=!!G2mfgG2p'
    'UgN8JX;99~ql-eF+juZrP5mr^O8vI@Jj6VKsD&%Z16Zhjqg-Euks-8|Pf<p_5>`ocrW0BR3#fLGVj+|pNH@oLV1wqlp|2weT)r`&'
    '%&3!(fc@s=S#&ThB>-+AVm+>awKCJYB>^iZUg5j{BJm3Nj61HTR3KMXC?y$XHOD+-=<;Wt?(Sv>K~-ann~UrCZ;^;loTCjZ6X(`S'
    'Or^X2JyI0SNO8n~(MMAQCoxWrILpmy=SUQ|(booCL`0*XXT94>xST^USAFprHt$<R`Pkfz${>9iKCjS|H(H3>PSmh{DmW$vdFY+Q'
    '8sUSRSF`FBaT3sqT4^iiXgx!`J70tZ3Uo8>;}R7O>y8RFGqis=5bv3jSjs)Q=_{h{E3n$foiEO%(@n^imf!|{*{Cu@VB}_5sob=t'
    'q19IK46J+Nmz;tvj@PKus6W!4(a?GQN*wbboklnR)-9Y{QI@YiMr*&4Z6^0L(^`9iHU5@Ml89E-yV)wn#!vTl4-XEjJ3H{-=WVB<'
    '$J<y5*DRHVcXQ&DAso&H#I$)IGyl{EH+M7eFOlDdA-RU=Ef(F;)(P;!?!ewU@R`35?Zu06dKkqT+Zmh5{<ZOJ82**MZJVofZI~^r'
    '5(jIGV7WDX`2-(e_BTWB!k2H}pZ*$hb}_XabKJSP6H%Iv$LR=xo&L(qo*wGy)04mMHuj&#aYI%_Pya?UCGBQ@Q8IK|)627~<+1c~'
    'VU&n|*W@)X)rd>4A=E9DNJpR$h>&RHh_>ph)-qDjE>>IRv{o&hPk=```uP&Z&^lyC6lh}GDO7-s11R#8X;i8uRs-U{5djo=fm0bg'
    '8B~%PZWvDz%u%OmvszMmMowFwymHi{X1Qyj;0U(*o`A^P{mr+H)$$0%(bsik?{SZ7d;KT<rM5$lfn`fWJ{MwM=u8|gfeo>MpBG+%'
    'Mz}>Cqi9Y`qCCAp>aLA2Byua=i()R;z8800VkM0ToHZn;>lN{7P6zMIfT9M|ob{uTUkY1R20hDoe}{>&Y@;nfx3Ys=unfY8AwdhL'
    '*)5O`l+BV^Bxa42^-?&_tO+yAiDKZizwSS)((rFDD58awSuzlXuot(60e&QEwgt7?K=5!QgjQ@pK?>>Jzl_ddkUdYU@U90NZabu('
    'c0FY7yL(Z5-|hRyzwab;<?JV)N{lCYSCbM7uGs@S{VW%NcXygQRST;vH^GqI(C{*sb{OGIGPfJ~RBC|61@OkIG<d%F1=|51pZ2q%'
    '=}&F214Gu^BjZB`iX!g9@d0b@3r9{8EBSb=NZIXtC_~~D%&I%6kKoKWK138?nQAd}=mKvD5D=wR3k+)C#Y+rF5Y>g5FypP6q&6gJ'
    'i;H+9(<7v0wdBGsbBhe<h+si0Xo!;O1MA3<ny?P)D??FjhGNd&Aw>q&BB~w{RWF#ayTi&n%*Y`bwP24|%8*X*KZ$K>m)nm}t7T#H'
    'xzvlc$H>{snDnbFNd-fCNAx_-I95CkwI1BeKhLt{I#TPie_v0A8wmV=0l$O=0S%jA)?cxE66urT@`;YOz)T|F%T#0wF+y@f8Me-F'
    'Qf;|Mcc|>E6z1CJ3WnduXKMvG+p5+&om!7mu7Y!)uG4ROZiG1`t-VgGZFWV~zExRACMewLs$h`2DIA$+{Vs9p3w8U^Y$&#JGDo2?'
    '5J>pK?LOHtl(j<d?CIH6a{m73w<nixj$c8A`gX2ZQp1^77TRXM_%H(uyYLK5?ceoQ;Vt5CfA553WFpaVvz^I~`nxg;#PRk91k4`1'
    'L1)Nq_^!pu*z{orcCO#qoaAwcMMWPz%ox?AkKrN+bY=j>4&%r52u#T%P!JD~0josw9R#XDr3(CE!={0}fCoqF{1r<DacqbhY6M02'
    '37ayw9hPm2c|}<qeK-;iuW&0rS9HX`9Tq7mAWv<mrPFPAG<$VzjR@rqYdzo91_9oMvR$yK$YuJ6!3n43_%C>spo*e+%0L~%w<o_H'
    'yNH_j_b4;5EjTWrvf{UIE^Nl>gI`z_LRg$1S~P;<xW3%BiDzK8&aDs%-}%@D;QH9bs0lcv-w}PSJnv%Q&&)1%&6NV?wuE2(_cN^g'
    't~bLjY4siZ!d!QLAW|G9?@tXK`Q_x|oj)j{San`MC=mNGxa7pwWaSxg%vQyVhOniaG5(W199kTiLFQe|o=<9j>{fg?P<T_3RA3M1'
    '>=*%umL0wPmBV<wFf#PPgB<ir?C@>|r-nu7(0PsWjoz4brh%V=gcOHCuRs5UaqCk34KQH}HBv^Hnu_YriS<|*Ipr?0DDx9xbrLHR'
    'Ne5H4%0%QV9@P#zW?tp{<1TcaroHF;)E$QD==)(E@=O!guZl#Ycpyw$BE_2|)@P%p6MTGByNZ-0S5?W6a6spG$;H5pG{qrlV$?v!'
    'Fu@v(X&807)p~CMsbWd(guHayAJ*IeamUHkAXhKa`&(l7T7D&a0SSBL`~V7;_lEb9Oc0^lHOc}IzLu)*0!4-;Gca8FXrxqvA<Ecg'
    '3kF9n^cI?8?FGC53#iOM(`XwJ`qrlCPbTPCWqLJ$zrqAjfS@MeD$z58$LQZAO+iwJ-|&Wn*8I7{x0^CTH4h>*C7QMz;;s|7Lhr5%'
    '6h-k_^=~niPO@2`7;ng0$sRNt&to~JjE>3E8bL!J^2zhkJtYN^#CVGTfF0E;ply&RMr4Ah2PY&Y>)LaJa+WeBBMcj4vs}?TfHi1q'
    '$Rh8uXeIckBU@aAi0YpzG*T`EZih%T>X6v{vTL5z@vXhQi1zMQ;B!}@Dv3Pd$(XAqlATw97f8>OVXII^!V(X!*6i5P&u0)B2`NUQ'
    '^O(ofE)0H;SY<U7Ko2Q<9mEBOPwD*3wP1h3qE4aU<P;Q?_E7MkMWG<CJ-@|m<{=*fJ<CFPb~@6QG|A}JXJ;b-XVnE}Qe%pz%+E*;'
    '3LCIe4M*_&=Y)XQtks?esmYe13!OVrI8GTmb80Obz@irlTaAU}*6km&`R9uL0ss7A=3O`Qtr{#mH@w$vk7Nqrd8AvyQZfBOHiyWm'
    'Qp&Y4l#13|U(&%SFU?Y#?L~C45`uLto@XA;ZL@RUxIio8sCXne3KTN(x37>HXLK<?1{cSW(ZbyNi(^clD#5fPSKE}zMn#y39=(>B'
    'Z-S&kuoeSUb-BRAAk|;Kdi%Bla0H5>1i2)R_aik;Z?#*gH5-ixXT}S(XHboD?>wM2QsWPCgZC3Dc+BHM+Fl&Z;dXi-<J0=_@jp&3'
    'ub^j8O<`mM{%c9Sz<cp+@lyNBlCv5@w+ztou<pk_%ow@2|L@mDWhU+rQQq{$$TExwCx$|cN&k#^2PH9-zcSnlvlyyJNiYn%lGC=('
    '$5qi$8TK3^)US>&32~fXoc(+pf6XXjB9{D=lo(kFs7ONj7D3C$=qF#2o;RzY^L0H%jv_@Cg@221zaQL{rChEj4nqXr*#va{<^b7q'
    'Hj+SJR|&*GB$)v^A=m5X5MKTwSLIP1AorHVNe&s=s*hb;lms<U2`jBDy~QND1y@v=mn)V~%=`i8cZ=E)Vyxa#hq~G;mCmIOHEahC'
    'z*Jr?C(Ut78*?iaDR&#hdq~a0*i72U0h3Ay`Gn1G?eMA~5xJS$({Km2K1BJY0{R{ABz#q@U3nz=Wp*3ZI~;dYy{Hyt?T~4axWtzg'
    'pRmW=m&q!DQwXC*RgAO+O-MCU-iXT1W1toy?Jz9LV1k(x#=XhZ<}^Z=mrO^PeK%irq4ybCcjZ*-K<RG>&z|iaL?NGw9@Ctw>FrZa'
    'y_)U+lS+gsks^rCsvdB3a<J1agcllC#8W984S)!#RzU-k1#hb?i6j#=O;Lg=^ppg}qEZN*3b>V1!9m0bs$jj8isj9q{w^wA=+vf|'
    'MBA+gii`C}T)}f{lR|=E7n}L+D8*C_R#&HYQd=7X`{;?)j47_(uo1o6{^a^@ewXqX%pzd&|NGGpm4Uc<g#TsJ=oDC&lv8Kr*K0MC'
    'HX@CtMfXwe79PuF7_Zqc4&NwlAzI-F%!jp~ameb=Fv4g&3vOAfh&Dv_1|Q=x<jK3n5jTZLWj^N|MCLCGwB~Q;W#tt^hu}%FK$iCj'
    'iV$Gys9)S%;-e^ue6^ln=zNky_TZ_2_H53`Cc#8jgyu4e6warh5-p5Yt0^G%<-9+N@L$9ALxeACNx2rc3+`ey<5Kaem<LP(y5Oz='
    'vdSs-0KHHuY|!^({z!8nv0oS{rBw61z<};#JQ+bRsP;>HpN(Whw@T#(L`HsD4~}MTY^tF~Nwu+K%xOq#()BxGJV;3+HIEjHQE%Cj'
    '!bzC?enh1oDPpbXXRR?EA8}R1={;sjUW|r%Zk3cueGq=EVx~`61E=@E3Z~O3<}ox+c_q#ci4)EuE#_7N!!_sM1B01mZ<r9iJ-)z@'
    'zH>0Pk?|;d#sRCrtCZ#E$QFpi3WRt#M7evAATo14k$KdcrG^_t)h>3P1{EyWm)@lYn6XYPbUdA7y-7UPp%I@D3+a6`^bEGY#=)xL'
    'Y;LBEITX=H2+I1vd6*frI9)%LbDh}oFt(&2mxNhiI3i$WuBoF&GkX!)H2ITM4icy8fSc;6u6kfFsPW{1&&OQ2VwRzV4WI&-@&W{|'
    'Tt^X$qhpa%Jck51@Z|M{5&4qK_@Lq5oMN3TVb|e&aZV7bYxZV2zbEo>{Eu_PohC*|fy`t7OkSP6jKkr4knU)Ml`Z}?m`>`q!ykFt'
    'wO)<8Rk=3PT4s@<jj@7n44UW>VnpLTl>0Ix8G_3|fXV!3pZv6>e3h)*0Nl9oWT{J#s^buj^Rq#bY_4cID8!ozbjQpCvX;V*rZ<yC'
    'qzhKopgL^2=nY0e#YkeH3Y^|oZ7n7O29hnYdMDM*g`0OlMrJ|}1Td}vlqkU3LR9XRs2-(~<1E-Z!#~W>i0gxq%8f_FUh`3)z@xp}'
    '5%Y14`uE6xHODpY8Lk<t<XCR`^|8k+hnBI$H0gQ1)_hFarK2!^DW<$VUXDDJ7UIq=x+vZ1ayUAzzv2Qp3jt<$fp~sgk(AZ($^~NA'
    'RS6<nE1kf@PJ<)TK`}XBDqdM%Y<F`0G7MWHy#QB$+HyySwZo4&!<yW3??Cd*4(gWu6-JZW-nDy(zsys6YlNqP?579`_6_Hq=q<0)'
    'xF}GwG$GS)VnhK9=2w>*>sv-4tOj#g+F{5V?ncF2l%{JhcT}xrwdtI<65&-P#xqUqjnhqbLi@P(2}`Ec?S&Oni}_aECXm^Jf>p42'
    'QD!U6bK1Wsvz<1Uj7|@*M4in6=8|29RnqZ<JyHRhM=cO}VwGmg+}sLmbu{=qM7J)$VKG%%1X(IJA4Mde>CY~&UO~YhD?jcxK(z*>'
    '8wL>Q#=%(Pv-?tfOxew`jD8eqq@u_UAT+OTgxNx2?&wk{u7AtWT8`uq)B#1(JQ*a*5EDu98L>MjOF9cB$&*;5#$NdtuUuG0(%~{?'
    'icF$HU-iNqlW@gkYL;LXKy8JjI5!ubFB?eYCs{p+)5bK)M3)jYGFGrSGPxcQqa6t^l`t7CWxsj0s)vkWeiI+hyXlYTPZF$a-W+dw'
    'Y2pYi{Ib{jq4Os(7PvSyKr3hBg$CZJ;^pc_mXE?5&1YFT|Gj?-C@O6^{c3hJl{ii0DaR+x2B4lv*mhDuo`^bj{1SjK3Eoj29M)|g'
    '*UX;J(mUikm`ibqHKop#B!gX!*ginzuAqK*a5I`Nh|dP?vR~aqPY1E7&0fv`$HI`<imK&|4UtnmA2YXUo~NOE&lue~BGF%*VVzzo'
    'N4#4ODVJAj%GQ@h`K=23J(+zHen8jduz(Y9OSRgzL1H7$?4yjP%xj8>x|IJbCJMf>+3wl06Vl|+^pCD%>Njyw_7U|waaITpQ8RRf'
    'lne=r6~2HGg`bym^xTo!0G6-zPJhh0UGRbD`$4)5!bO$=D)+nsah73&u(LvF-yz!Su5y<ttU5WD)xD*dq3CSrQC*Nmj#ii8T;2>|'
    '!|)GJHLh@SV1-Max*jkGu#1JfVw>&34+E?$x8b%!%(PiX6>la_g!y!8=z!d>nd1Y$_ldpE#DTj@Ee!~C-FqLv_4Rgi-{E_G!2^3q'
    'w?56b{LU)9?H=JdU=)TxH}#ZQVggoPzKQZ|i!F6cMIC9kN3A&vEZ%YjKjb<PtROFjBQPy%oJsdxJP4-uik^8_-Ud)mU5(7`SF|`g'
    '<b*~;jWxfT%@fd)B+^9Ot{igUhHT+UsKWET-Dzxy6jBzj=q*<hEO)^fsPx<=mWQ-lSE5;PiKY$lL^Zx>{bu*Uz>vWC@IDH%qyY-z'
    '2~*5i=fmtAibTIXdr67Z&5z5o)600goc}SJLHUcXkjeMvu3uZtKaOTKc91j(O^KdRw*hk()`ZKC*nJ!x)C`AI8;=aP4nS;8k_!Xn'
    'R_IN{Nwvb%9LXezBlOn-Roi3XO<0G;DqdUIc!$*-T$|Ad)o^sD$G;t4fRYc&W6$PV)CRpxZw0n?16p;iT*<{Jh*yEp(an_8*<)6v'
    '8W^?ikgs4DXW(s6mp4hR=1iDFW<|{A+eQ5lH{o~I6M%(Pcm*F)-Ctg6p&>;X1#*s+6kE<;7g`I~$Sv&j0>-dH0CDZ(^2}JU+?sdH'
    'vT^L)Lym#ai*vJalDbNH1xGJ%5L<vy;A0Pwxz8x%sz7vLbZdC<P=%8hd4&Ety0^ZddZ)8KS9fU~{&IBk*2rByAOCW8aSS@r-%ef`'
    '3jgZl^8D!P<(tw);u@?qHg?dS@hiyeLHUZokOCk+F@k^MSOg-=WNOKDZEI#H>D>Ty1W<5lv|QRA8Fq4t9}81eCrY^LDKz2R(QV&Q'
    'Hwv4AnJ)~~Ra+mNb}Rl0RZMD19i$Kn-nuB<MpxvuQe7~u%(f8tWRz$){RLFSDs7h!qWI?Y5VR7iorntrtjIo4Qm}wF1Qe~A8h(OO'
    '%tokj5l;fvtYhJr>7=hUX1%4s-iF+m1_sSi6I)Y;_R@QTwX<=?Qp}yR?tsz&rew=86yXPKZ~bR0QVZUd_E-iLmuJ-Kmi?HkN=SQ)'
    'M+&M!Y!iMk|5Ny-lyI$p+gw<$hq_uG?Ii&h@eeL7cBVi&I$+sVZOCF)cX4J$%(%HvsqBLuF2mzOym8FEs(2jBZozvS%ZiJ`FXD{}'
    '^9{AEp%vT^&w2lML)g-Miv09u{uyw~_-WV@#i|s(7t%{!c)DN)J8;UKC97z115r`qF^c|_YKiWt;X{1~EqIl2??Ht0IhplD>d(3$'
    'wyn}UmsZyRH%`DN|CV}R;?=?VtuPA`Zu$ZX#mAV33+@>djzLEeOoJ9TSiYm`2+*|pQ!M$y*lP#YpsV>*+n81=?sVH6F$#Z^6Rb<w'
    'OKpqt_A($mFlBNOY)a8=_*4F~g#-9&hDUnQ?6FGs7e}^Tf_t8yN?9jnW=QdJGV_gTVC^{s<IJ&HuNw}rRqj@t2+Upp><+Ies8=?H'
    'Z;K{eQqW_vJ-A|)^<lirDM;Xc!A^uS6A$7;wKH3~wLdgn%G%gy+<*tAGQkjwRKiLaN>w80;^fd0<m)G(j^s?UnbD$5Iy6R6k)K*D'
    'wuc{idC;~^f>yN$2<Y5MB^As$>f}g9jBv}$8!XAj_pjQLzr3Bm(J>wpPTr4fjxuwuR^4sS-r5-d+kPbUwhc;hhC{|mwhE1d+~J7O'
    'IC{<bXb@cUC)ZRO0gc>M-xVi+7OA~SWd5@|tBsiXxybx&T%Ie-FrS-8%j*%ISK);0C0~=oQO^p1BvXdu&txsyrZ5Vx_(8Q%fGBRx'
    '4x#<6i(>Zau|kdxg()E)H-G^;>wxP;Mn>BfX_DSV|I@X;R0I*$4^_L|_6^ugM;VY-H>Kkz&=r5iZmH+5z6;QDw2VLe#mhGU9%g;Y'
    'w~HAE()+ZXMhh*?;&gzx@`U<jnFXqCaW#v>FJT*O(Unxv6#F3*n22`)*upCpU+M)-lh1oW(~kKL&a}@C*YXuqetH<e!9FN9;b<g|'
    'C(!^{aB#ikw6QG`%AQ2O8=4KCgSMP$;ngcf1x_j9(^Z?T%i*D%DuKYYEyMGFQH=p(GZ@rl$)U6?NJXB4lcHH(+-XQoVo=LL!i1JY'
    'J<0N6c9?7774J+X%vFoAjg?MOXA7~L`jCn<5-a)H{HolJ3?K}nyX7?M&xiN8`4I*ph3s+3xxi!{c8z9<Pvd4=f`b0q*dNyZnudR^'
    's0P@Rgg4PphHXQS@|H!|3U*-%%Cr7&@xd-6KM{%{Yy0=hvr}=S&4@2ZKKOukIAY0AZf-384&*mN^WhypV6)qR6R|;stPEXNL@S!`'
    'NA@?OIMSU&NU2+n;mmv#^N5sMOm`6D_=b-)CuPJVwO}|Z>#5HCU&%_L={Cz`MGwyz)|;4%ALnoYuEt`3Na;)zN8&jjP_8d~;r&7`'
    'oUAJwWsm_w>z4qfVVdA<vcA`<oP-T3Uap4*cGc&7lHb*~g>si`3g7URp%S($zRlUnP(U%s4I;+7RpN6&x68U&doiPe3z)G7&G;m>'
    'ppFW0@};!y^uf8ABdnM_e`kgzUfwOJI1LwQoDHS7<%qXOIRM)<0nWlGo80!C*U8R38q_&?kwpl4lgHs#b^luiDSX5Hpf%r-`fG?@'
    ')L|=>6@z*Q6b`V)u;m+%6Pb_^8u_npoXM!HnotRxw1JXLW)x&k*ON{xYXGxPm2Zi8Ep{>QvG)Nnk-Dusi5z~%>}=++3?ZB4ZQ&$d'
    'P(hrG<1rU74IN?gR*~~VX5Y;)qAyVt&d-CQU0n;xb0_Efz%7>apdjEd;6~G4e>9B*tz`&`y;Kx4jEq~HW#p{;e-YWRF-Y9HG|cER'
    'X$!9DY3O@X<UJAvQi?%G!Wy(Lnit`wYBw&nJLt#ST69WiXWNLa>~3w1Z2izJ!e=Oo6p|*{s8X!!p!i=H)FtQ5?DEo!=c3toj3RZ|'
    'k-)C58B0#Xb!G&y+5EHV=6VDv4FigpPeYx5HXnk5xdGN}oQFEA`5+Xu>9|0Y**xi+QyY4LCmiH_WD~(0z5LZ-cY`F-phwo%I%muP'
    'BjJ)t&(CZbdNek2U+A8V_2`9ekdHeoYj_6{2=~x_csDTD3thIwgkbp_RBsSHVZs!D{n+|MRhFYqq@pCwjrI8$C;vlC8pv<@OXazg'
    '&u~sD6|kpusV=j5-U~k?CB9_Obt!W>%YvU3yXq1;WV+EQcx@*t8*jB`7v`r7wQ%QEWh+Cd--{fw2$&~ReH?7Ty{*L;Dm%^p4JZR!'
    'Jsc%iIczz)?SZY#9Hqe#vkj<H96n^_7V|TCWeHaZtWR1k0JJxeQ!nKAzma;#rICmb?L+ggrwI!3JhD*Wijac=Vo=zFz#=+>&pf9B'
    'KSzD>$d-6`*`ZvgZ2S~kj?-|otQ`;a8>By%B$SqaVnZIim0}&}Bj>Dq8P)qbdjtrMagO`(%=|t(j0I`nKd!D*lqpdYdm5xdbATup'
    'Bq=RS0H$ICYBT6KD$OhE3<JdjRa;tiz@5ib$jCNReUrOepnnkKZIefHmz3?CrC&tnXyNHlVn_TJi<Ug^vNXsHpPud7G|bqiC!W(2'
    'OMf<Q5Yr;vy{0?5Plawgd8#ypwoDJxXiNGRCUh~r>(F;C`p;8n*lmCA&9a+d(^h*E<&^I9AGIqohPN^HVbvzB-MBd}M}GORx!rOD'
    'MYNL4c9D#fA9S0+GS*p^73_#sVN;EKFn$_hzI;xaU(sFLSrTC?o}1%TwgQyG!8uvKN7Ks2<8<ByJ@K1AaiJkGsil-2A-3KwWpQR3'
    'q`LKZOziOvV{4Bi2-Z!m5siS4(I=-0M{ke>?R`m7RjwVB84t5QZ}L52R{~Nu`T=YkzHBLL&W9OE0yEqLPBVcMmoV4Fy$_?W-^dy?'
    'j@{FuZ&YSpAjliyqV^l#&{YJ3>J~k~ytsMf6UQC^o&>**$Bc55ah-X+;GD6@p{^!O|B*p9dc&~Wi|q@N%#A+POfM-&0dEW-8#sa#'
    'zHD^jG`=yq%Y|-g(9)yCn3Or|zhmcR9i|IU0^Rkbniz3Srnf)q+oKm*<lwUb@WAuOtvAnlcyMVAfs5Yf8C@e`R3)Y`A{PZTQ4upj'
    '>U;hhuBdbCZ?Pp*jA(8r&e4u4otFhI@>peYi^^k@9X5T9z>fhA12X!2xk_E;8F11?bufi*gIN!xdJwaTV>MeenGW0F7fc}B!`N!1'
    'cF=vDa*;_ou-%_eUMn4hjpC%#)8gK$(P5EeEF4p90W<a-VreKfta90uq<+2S^&OC|8U#JpR`YpnItR}o@*pKOCi`!yLqo?2^}DK0'
    '5fHCBQ#T|*Z{o_rK_`%`X1kzZ)e}KB<~Yz_WDvENAUQ%W>Lgo4m!6iD(q+F7Fc<15H@t8OoC!G@pn#ym{#Wx`z+`AOz{Ww(X6Yo$'
    '54z^GQPE>$4b}*yqmlLAXBCY^r)Aws$kqCx-X&Y-8MG;AZL&dyb9L&NZTuuKU(!Y=2`Zt0yQOL<AaE%ch?1fhn^WFBysXnhd@&gL'
    'K^E$S4j4T>D2@tZh{;n~0S;xofe&i*!KOQ|+v4pe-YcI6C9<iX-7A~*IhSXSvi+*2_#mu08*6VBD@{VA*s-cz`So<(M|%-v19e$o'
    '34pIK%Y|Xspd7}08K%Kkmx?oDT=cC?kuhZ6qXaeqCc=h<HvJLcSxHGUbT<Res5n-^`oom_=2r{DZ`Z{%fNM70_ZU3RU5eO9obkV9'
    '69-#geU+^kyrA7tY>|<;pp$CpKpYg{r7F(6<ebGNF$tUyn+|t4f)J%;LWgWUPEcNOP|mIHBh0H}4ojW?D|#37G!*1>$U=${o9~%u'
    '?wyg_rl>RrNN_=elnDqZ>nWj5)H`MKEk#6wP5a;8K{j@o8imwIU=#-N%toIvzR3X=D#MM$B%#Xa?S)Ecn;O_<Thw_Ms}ZMCws|gH'
    'CdI0x`=eZB<i$!GYg5%q7#^hMDsEsiZh?*p1EfkC@>^*PCO15Z(hpP%mEoCve8eUoZax7<Z{Alt-yhsJc!FDHW*YG%BGq>lzO7^u'
    '?^5|R0Uj-~3xvd3Jfrogld*#&j<WMQ!AjfZNu^rIfT=kWDwZyzY*el*jZlIqGgfb??f@@u=VmJ*Tpj(0=+5Aj5Y`&mg;RqLyzIu='
    '4xa9|Icx`{TGjMvDDgbtp_&^;zcxcYZQ2^5RF|PF8C*_Jz*pnR6WOM!Hn~--y)6=VgKEa|mZOPzkSsF8*;BF0mp`I47P>N$=4Fb@'
    'oLMe8EujIIw^riYKp%l3cTw_inXiw)3FP34ux~c>r;}6{e^#()3$!^Hv{n2v3z^I+xDuDzwMx^G+xlmxRC+7QX7m_W@xjx;yxfls'
    'g1Px+R=O1+T5;oURw)sef%ra&D4aIIa9ZcY32g9fFa21-QUTSr4FlIwTRWqiP<@9WRf}tOM)=RCLlr&8r_yRuO1nUU8}P6g^w|kf'
    'Zt+5~ZAci-!r8ZZKAv8P6XnH{b`=@e1j95FASYoIgrgZm`e|(xeS{`ud1=}WCn+~HKO{;FJ2br1-2fu{IARxi=AlU&0*WaqK_&_{'
    '$R^dT7HYkKaA&JxwYO2b1)TBg{prtV?@wQmK*DM_x4y>-3wwxaj1_;V7rULLIDMSY#!ybT3mj5`qL+c)G{@4Lruf2UF>PbnFx*IT'
    '(K1&m;ZkC>okR)X2^bwGM&=uv4k?*2KK@CU`2#kP?{P4I(s-WxF3Mn{cf}vTrY)~O#ZrJEfnODzV}!j&*sR(Xt89|S7w=D#S7w{u'
    '8k~h$m!O5PEac5Vk|djW(+c&`X?EN6Vl?|iI{QyTY%n4P40}L<sx)X+TFmZg*a)BO?psz9T@(TB>#%=<7y&5l{)`KI>Q=Pf{so++'
    '(p>)#gW3bgQyYxIXHhcx1N;6Nsv$v<G~gY;Sp_`BARnAn5<&M<z^et|k#B`yLa7>Z@A9~Z60jCD^y}Fn$Rl#HZ7Ed{!hQZyf=&{#'
    '1L(Vy388I%7dW(&1G9Oh3jYDNcS>^DXgVRWEo?FeFnveG11bz{YD}e*CMAT~$I@=_cEX~`KA7LCNTS7yHE#afGR<35rYzjyR3jnO'
    'c9O9vTEYJGV-(25<g!n}U!=+TGQz7w3winW?ER~sk56B|N&bFx@y-@Fgz6M=?n#tw{@dBx_wRIT^*}eiIDUO{b_%r75S%AZ=sqJF'
    '1}!Y!Y($K7<#WTlIzGQlj^1CL8LsW(`0`C`ZnAE4`RmDf0?8HLCYUfF4x8TlpU=*&lB<iO(@RL68jDvzt_cMO!Plhf7yJ^hLp#oJ'
    'B+sdx>iq2D<n_tv(OZL&l9SV4E{>Apql>ry#1uwhMD!G_B=|=ZZX&&&r=J_Pv-OZ&9!li>(LHHefHSZFVuRX?R%btf5{9TOa@g>5'
    'Z+W}Jv2XK*b~uLcY4atp0d~^ncQ=+&WIP)TWHh7TVJD!bOt4A{*y5`-cw=YD(}RyV<lXfR{%xc5riP{q3vH4^5eMr9>E!lqiYjV='
    'J(=MLs?<dx&8yxuWLo%^@qzhN7|NXIW|rZH4|T(U=oAE<quPJ;YJV6uC#l!EPs6A%D7DJj<tYb;O*Ij`Haz0(Xw?IQvrRIOvs7XA'
    '${mNXxaXC##_@($<wjs8$Me9U;W~xW#<D>@D%zq#aY-Scs6E5!Q3wn2w3Ar^z>}o2-Xgu3uN2fpG$8UL{1ydVLOUm?zZuXtyZEQU'
    'G;c9`qiPq=pf+h`;>v8}v@m)+H}^R9y01nkTkw|g8(py}LIe!q5d#CVQ*yw9MFg((%uo@(GTEAoi|e^OJvzU9V=$6i*e@q<kHOm%'
    'gBC%-w*zLno$#qQ-}VE0y?k>-Zl2PM=jLhC=i^S7Ggj$nV1&4|j?!3iGx}0#?pAHVHHAkVBd1Rm**0%1w?FKU<0o*@q9z%_a@=%h'
    'yEG(Sf85yn6%jkG_}ZAbTaWLJ;h#t?QY}s62MU>vvVt0;VrFM7SF9?6QT#PA-d);4wg5;y2mUXLuso#rVwR_;a3%t08SwQ~m>X3}'
    'HK7Ob_r^9qFiS<&HtYxHKFmJsf1^_-xwRG9eVv^m1AO0S5H2?Z|2G?WIiFmtxy<%-ejOL*R<=&Q9Z0QlqkJy37ZK->E=V?1lz-Z='
    'gg(>)?y+o_tHEtJN9L_4@sr}f45(_2kavTMlJe-rwn9#ZYHJ$3^E7UK_<)pJf2y+Tz?Kim@?yyIo4Y<FjYn+Kn{r47;N;gQS8v|`'
    'oLrs#dVFebv+j%*?V)Y-Ry{pSj(_>(_$6ljKR!9X0xTeM0UuC7b}(nj0H%%WiDmn~0Jitl$wln+AK517NB?|#cJvAf5T}md`buRj'
    'iKxU1D{Y#^@h^C_vd_8Lfy_^`kmo<YIyyN`-ke=tWjTM{P3imJ3~4<1kK;HrlmQDE8VIR9|5DiS-SIm^H{%ffXY(!oes=Ne<vCP$'
    'U`Yr%PG0{Uhv?;`(%)8!1O@El>g3(=+54;H(xA<Tk@$Y1#AcrXEQfQ0PQYK^2>(tMQB}G_bY7CSB%K>T!J-tPXK>mF!x7)5im8-5'
    'uIQ;q`Ml!Nr1NVMfVI<sk)Y$Rp`fg=g=msmn5l|oB5YASTq3DeRO0gR8|54TiUW+I^skX$<adh^1Lh%&j=D5d4dYMX@=&8d7cJ~o'
    'zPbdaG(Cj<Z$`RaOyrwiriMSL9G#y>bk{MbxFOgbBoN*9d^$wB3N<w1uW5@bv70lczba`Jh#|zuR{SdMs%ZO(k!Ze2z%K^iSDxI>'
    'Kt8FqV6;x7i;BnKM^+Y@E<Xd0uwqv$sVsx$UY1Z`$Usj|<|Y&4ya==;@EL=A_nbBVOFtAZ5EvkSEa$e8x=55ZnDY3LZ%I{L-e-59'
    'GmUr=*)>`D)L)zbkw@vE3ItGuHd;iDK-VrwyDj#`xY6cYLEniMhwXs)Y-%KRs%K5VLD)!WfJR$vkSshJ#0;624H+7YRBI07ZnPcz'
    'C)VdTlb}*%tm$F$KE(uOxqwnNla~at4oM*KiEb}%s!@jh0d5$7u(p<evbNS^lLbM=In}9Gmn$dJ)L|dY#u(wo=f?{@=9~h|<BT|0'
    'KqhLQvWW7!%}!UUic^s21<p}Vj2Sll+?$}=b`DGf($2&sX;{&&gFUz^5s}?=m5Oz1TFxN^n2s~c<aj)@%)u)r2A@S)n*pCzF8)1t'
    'Y!br|sG0<R`HR5iV~!t`idwe*cH(RTn6kn)vsqSX4kh`oZF|vvuS;yb26`l|a8ah|u-XPpQj*rX@Ddlb)js?*S6DnNv0z#qNMyc3'
    'jY48e{6Jv8Jk_&1c_rXcl+&tiGdOG;Vo)~IEIN4jmDE>k(KD3mN6^Ayai<z8;=Fo37)b^G#OQ4d5QkpIEKW*v1IIf8QDl_MmlG`R'
    'C8<sOchiqH&kisytkd)L2y(GF(~^<S7We!JI!KCQB~*aKmP5<MvYI*Dx4(mNfuh4T#mtpa2oI#*Ly_tZZVxO2is0afV4`&+R;!)R'
    'rXT8NQY|UKATKzjdB|aTPPxQvOtb{Iw%ZZAGa&;<D=F3CWR@lv*X1H)`}-yvP{1blEmcG$f}?uqhs_eWjiA!ex2We+39l)EIohy*'
    '@kAX6@U{la_YG69av-oN+0~yo0UMrY%VQ`^E4fIr-c~=wj-%mS=OH%)V2(Xr;Cm@PM`mH&JlP|giXtH2ws=zw<N`jA5Ky~-CA0Wb'
    '*QBUn54FEG4%kERugoHH@rSCgj8EgHU<|_((Y_m2RvD6i%F|U_o3W@I_?qIk<bw)YBs*q-262spHeaZ<<x0)}C>}Rki8RZ1c$=nk'
    '@f7Zz$}Zu?fSeK(8$`uj*+s2jg9B9%$va8w3hAG37PhG)#j)pH4WD5XTN+~9Y7%_WD(f!Vy1C2QxvHI>|K<;IQ6UsjBo^J`nm5Ex'
    'abZ2mb@!iS6yd(K*pl0`y@tD{+@`!RSpm1S5h}UUtoT(7nl`&p5xY#M?!`Ul_ch|#Qw#bL6*5mniz&c80MM3`#<W>l`)aEX*2G+-'
    'V9I(WTX?e`$e0%j{gtuHEW;eAsz+s2V>Z_Av)=pcG>IdXYv9WkWFt8s`G2;e>BaH?e1CFbV6*5bw%v9=;-lyQU7;FUYiu9TRdbbR'
    'szr4Mv_O|B10#WBYaK$o`N;;w1=U@pci(a#s?d$)2iAIm(iO<0^z<q-eD~oLZTZ?|%1uCJoUM%zVf>Vz@;gW2bg8#ORJ$z(Z8^kM'
    '68`aD&+=5uqD!`6Bs|Pn>WJQ2gEY}8ZncC$LxALi>3qJB%zQmp)>vXsZ14e&jLuwMQ9-UllNaNo?U7EV&Q_E|eFgQmtUkd^Vk=N7'
    '43a1ZkspH#%JLz;gP58M>;~wtfn}CJxoP%{OI!QmI!-Bopi`))j-pC18BRy_|7%Gnl1)6|?Nq2+a9&%U4{v!!`FblFC#~=(D?FIL'
    'x2hLij*&u2b5-l&bulz~&-a4x#QZkpo<v3E#9UCYJg!#3?J;`?Z23{a?2lSV7`N&1$_W37>cL%AguvM>xYDnH2v+=M#eFV_er?%b'
    ')x+8_`ar_y;s=y+ED*no;6AUImK&hZE32gCqE<4uqqHy^)y--sZjmOKV<Yn@+p;X&<N>v_9S*nbD4;mf`o#~dG|wHBBRTGNJ0yo3'
    '1(lXB5D*|If~33!6feGm4o)dA0?DRrio~Se6t*AF!QYzVG+FFJt(FXeLExw`+<?aNuiZras7L8~qy1_lBG(2jkNw|5W_cXZ;MLjR'
    'Ptmc!a-WySM{k9F)SM@6z0X|#7clSN&#!wk`xi0q58l3Y%PU~X5i{vbQyAsuqZPSN%lIMXl6`oM)>llH$z+PkU0xksT)jV6o*6b|'
    '*`Z<{;RjdE7U-$w|M;WC?8C_~C-m_;rXc&hC|tJgr-1jwKK)vGm+#MyFMd0@JiBnqvZ@7)YSj?I`PaAMS2o-l#e2#Yy2gC3q@rk|'
    'j+~B*j1vhPH)Ezr(HgnxyKR;d#ThR*%F5MEHdNYCn<25t{3*E<G@{M~Qo1{lV_f}~k$0KTk56BnoW4$u|8aGEacb_bxzz?XP)i)~'
    'hGvdnHdi$aGue54<tdQ8jkVI($y**vKz8hsMQ3^TeB%eKdjphi1L#@&pI@!nMl>yPne1$iW6prYe4td1<oej)(=&7NQh$tskCQ3L'
    'MUdZ~a_CYb<Yk>ZykJYFVHMD6OPEEA8QT;d3W<{K#j;tEQ}%cu%0VUI4O=4&EL9G0Dc0+|&&vFAoB`m+;8)X@tGRM@-Q28#9?q5$'
    'M1lLlG&tEg+u<-s$!!X*4AkYTIRYKuuoZDvlDC4Y6dT$3w|8be^Hla|hif0>*#W!8>22#0$-kZ+t_7uH9<jhxMywMCs6O2$aGVSg'
    'S;AQ8?F1I@BF7YPV0BI@1+3`*>wYFm-tqlJS~;Vjxf(+%75H!;6e*iS9pshhC4MLNi%0T1$vQ%4=abp!^E&?%s?dOK{**TfI=N6k'
    '<ys{R&zsE3Vhas6>M--?`QL4Cmc*SK?aT^-=!*y1bNMS}(OtjihFSnAfCw;~?!K2HNJ1kfT&o-L4iW{2yUir;QzSR_Kdaj)_N?Q~'
    'A%!x5I%wW~pD723$+>y06_de(MH1gTJKNS$2TL1@11gm@N)XhBV^ajUi5V}vL~rQ88{KT_?rK`<WJTITaoEcHEB+Xq;6|DGV5Yv='
    '+>ziNpk=t0$PnJhdKO<V=cMw#n_;k=fvxkCSHaB)i8<x#AUXNk95r~M`WfOm8yYw<qq5}l&1lBT6u@BIol}RyMNIt$GL;G?NQ2~Q'
    'sD?3<`eT0EpBRemrAFg(Ay-!LV*NoUGT$OI8kuNmZM`8yu_pZqa;X@$<EMF}0v3S8ILX%Bd`A2mTB~5H7y#5lH#P@vp0gWdf^x~e'
    'SVLsSxj@Yha641j1aD`^SBY|>v4dRDTaJSMe039C%hhwoJmvJ$^}x&<V%lMGu<2;w=|gEi-h6B8fd#egPr?<be}z`C=9-sS%&@0-'
    '<~rE(C`|%j!~G{IXiHf4xHkUZ#u)RmX;TaG?pj&IXHS$ZDU_XK7ei?X?u7<D0_QxZ-QkD`IHR~25h+h>4$x0*=9zUt`qWl;D&N|L'
    'aNj7h<amjy<0bGT6@=}OyY~GPVpp<`GJnx3F$4A?&PMnS7u4dt-Z)u;S??Q_Z36Q0sHN*SYL(ie#yxrK&4zs;(;)c)%W@Aw;z4kZ'
    'viytUqG&b+oK)0-Xl?sqN5aDLF1pB&=(TyQO33#@O`6O7@vQMGp`Rw)8+V<uFR^|+vfxxfzBGDQ@25gPc0VzzUH*olq@<T&%cfQR'
    'lryxAfXpVTp>vQMl|JjZPr7;%wuWSWP(@~>j|F-q%P++Ees_W@5Jyp3O+d_RI~A!<_3R=f{O&3Lx8E%j5ei?tL+>8$hY#LUb!{wW'
    'Ayd%FSeV(BSDgGO!}dxpP@-c_k)L2nd`rhDWG0O}AUrP!a+c|0YWSJ37Di3T!P99SbTOQ1fsBbk(%>24dHX%7!5!+B{-Z2-yg^XK'
    'g$Iw!411ujtTiz+pJppSbSNOYer{DN0yV-AEte9pvbup35QdQouqZUU<BFFswys9-4%pOf@~a}I#Cc&#4&@lNeZp0pZxquIlxJSe'
    'zLFdyJxa=E(LyHCX<+TavXx3>3mJ+K6~Z4tdR+oF+5o7@C5!=hk!wM8M#2MV#3IAW8R-Ay2r=Rc;@>7Kx0~!dKOW3hQ>cv$0FS6j'
    'CV-W;<Oj_i-q&yDASCXD^?|t=qaBUHh%|F=xnx2SWjf{*(Ma@@`A1GdHkpm*Sk9t81@TNJtT(^vm&wWHtCNcgv@!@3{aE-c_{p82'
    'g=`NR-GM>K>QMDJ|Asl}fF@81Y+)mDoq;tE`B+XRY=#N$RInOS9X^5V#FV%B?-#kM-uYVI0KvH7^)a6Jco@;ow`VVZO^*NZztykP'
    'pS2bcnj8M-<P2fg%lX`<BEk-`4V?#e3HT_67jrdI0udF>sgUA$=<(GFAk7Np^aF8N@Y4z^6HVi1^+qX_UW^C`ygEjbPE|2Ll;_1U'
    '<E&D|Kv^aZLs0l4uYGBNm)LpcYIzkY=tChZVYL;Yav%zFd8~1ym5-UYAZlvZb@1jNMkUFB+0lzwU~~PDAE#V(_ajd(fB;e`n+Im+'
    '4>ODRGAJn+FXy+p$!vuV16l>J?m3bS4YK)$>%ozDgBg}t>zj?dM%xTsLu;&&flLXe2P0Rh72NH#1%k;cIDCe(g#idm$Cg>Q+4MQd'
    'KX)^hL=XgE2kL%OWRPvFFbfm##aX<uRFUv*W<5vR45ew%KyR+hO4(#mj@TfaIWCkJ+l~jYd8A`(-wCmnSHwT4jr;AQJ@^59iFyrp'
    'zv6YsoeIW7R%J#kB$4nW3AOww%mV-XS=<88F-boCbnAH-%2B!Dh_Aq40n~YMbb_qA_SeR)gd<SXsxng16ACrZF4}9qhikr-TQsKv'
    'wOxVB1Ft3LY9P-`V|g{tm`!s}&LyI6cfJfh@0@8sBV`zB*T@<~3V7x9<Et3sBBnaSy8@VZGO|&(z<7|CC5op(8<|T!>p6O`9hk}<'
    '0$PeYKyxtE|IbADt6y*4pWAqUMtwtxSsyRK|F=btA@JY+<s5G7mxSK<8<O*Ea)4eSsfiF%XVL-WREIJFOm4^_?}bu=^Ab`K?OD$t'
    'QRJ>S!X3RjJHI-9g;qDn6mpSq9N*3lyuf^BH%ptCB^bhmWXcn${$V&P*#a-iF$W&m9=9?im!&sW(5SirbyLE|fYC7K${0?Vg7+mZ'
    'bekO+SPQ+)L0lxSj<1ehzRCLUXSblp?}s_MLkg0@+@zjqCx12DlIcF4vZ*&C;ROZZ_z#Up^h&z@$-u$K3kGy$7|NsltQ_HB`C;*Y'
    '+lKm;hXy=aJYUX|UJ%tM)Gd}vi2)G#?OPY2=L-y!IIQG~+5i%AADC6F2R9c-P2QirJUjj6<l-G<hBvGR^%RGvXIIJj`=8&QT*5{1'
    'OEx?N+hnxSjBT>W1^<oQ&4@FX#3t5Az@#)9;$_l!rVJI~KANd4;!x@B*{MRA=z_{{K1e-r+osJOOegi*VKsbIEc8k{vRxiuUA@iW'
    'qvA~}B=r*Y<yNb_+`)<KR@*Tpf^%^n)M{>9!ZjF={9xCF32m$r!-ZE%FQa5e`2JX&yq8b8k#U1<aSJZpm+1|RAoj7&$#_d7snk}L'
    'CAZ5pRVC5-|Aur^g;JkOF^(=#kjmAi8h82Oup*jMkz^Djg(<1F&1>b3;9J$Hg45A-Y)DGFA}c(Lu~Hi?x|>Z_@D>hj3V?Vu0?tDo'
    '*Wu?&1LB1IphI{JLO?TNH}nb&!N?Jfh48x$=xVvT0EsTGX#FS&HqENnANj{6<olKM0s2z$XypD?uZVOi1zwC_8UMG4$bO5Q1D~5Z'
    '6`)I8RH$?WX8km=AwqgxYVecv6zvB(_KkeF>0g@2w}>%gTYY-`pLgc2d0%4dq7S2junw=YqIqB!?w{OtC~WQa!}Bv^Dwa@o`ZNK>'
    'O#%ddm>8-)8jnYVRYI!gG<Wc};@*{1rh6s2&k6+XNTMZcCk8d64vXI8uGTKfU<r1Uuophr=a>aRcr?Sv=GZsLuTu#r1!E0wQ0;b-'
    'rce={U?i&O@Rr^X-<shW#$Bsy*iwyhiPpHDyPRGnls|1=8DS8(dLNJPbk*Bw6tH+^;TGwHr@a1**OV3L_jmVqBX#P`g=OhESB78b'
    'iP(&=FXeYAk{oy8FhY9Q2W(RDrs&-547Vo7)ymx&sqRL+gc1C+rQrB?(VD=BSIIcj8(HDElUE=Tom^rbdD*$h-vG)$lfQM85Z&gd'
    '(&zfP2e|<%AAZ2frMUpBecw_02!-9O4U>szG!d&u2|g`C=7bO(`eNo?@Ok@Tw7`B{fRdr<mR}dp64<Q-O$bR=;Fsk;3X%kujIg=8'
    'xBu+m@cD~IuRj=uZF9~THcDp7Vw3-P@@3_)=g=H6HHW|03l{77=3^(b@uXpG5Jn&V!u$iVjS+C3k!jdQ69g#krjx$#7%=&EhRyUf'
    'XOy!jc+zW8-X$0kQfzmc-73{qO~7@tVncPR5zT6{svJW7ITAQRJhxEu@NLBtA2g~T{(>wWtQraHR_Vf}(z4o_lk;O$ASic<n7+e?'
    '*6C|xD}l|g*m6P<PdBfqSk6Dk<>gVGY%ZEo#1p8W#Sy_9PwS5D(`s3`4N*<@FK9C2Vz7$LY^+l(a)!V3K8}vgPb|VlAz(2<0FQ1*'
    'tDE@{%h^W#`S3pC+CC1y2ed~4wKS6U`Pt<a3fNRMKHL!xo1O3}+Cq1b@osy8y<nG1Z>FO!b@Ez(u{z=47O_0D>|6_q^bYp8qM|g@'
    'zr6jYEqikE3TwW~%;RS^{D;L@1cwEmti%lCZ}UgwVpA5%HNW}*$7cUHGD>nx$4p04&8oaGl`S7nMKrjZ6<%4u^)*!yF^$gubt~;u'
    'yW~2c%dFek=&+zATu+k2@YXvPxRCMPazZ?REfKTdHeC<#U#4=J_{_S=n!PNXy<7`@(Us?|lWK1Jlk2<rUCNrU1O@s;OugSt8t6W%'
    'y9gsD33yy3i58bY5KV0?uXkae^r9zEKI(Q)<0f0+u4tuXgOel!2E+)wG-1kTRiY3Z>wWm3Y_(Mf^PDIUuEfE<8Ao5AB8UGHME=DK'
    'bIE~BmZlZ~^ml!fgKhI6?Q)cneESC6?SgPiSgsbJ`EDp#$SG~f9T4`9zKa6oPnV)woMtb#YvpvPDmf6S`~Xk^DHl+=IDU6_bu2lF'
    'q5^n8L|OfgaV=H_-XzR{B6zeeinE+@{OuYt#nZ2DLxi$3E~IN7h@H+E%D7^yiVSO5Xfxwa#vp$YJTYlgK5vzBZ5_E-fs1vzN_QA+'
    'e62B-P7(W+w@Wesv{*2=z;iJuh<tb@76={6;*PxU>~(G1PP3tZym-;2h!2uc2@t@F88@QA{BE|2cN<*Q1v{m`^<h@R4<BY>9hr1&'
    'Qhka~s&y(~1SWUPd5zt|wDzKABZ843!D$-rMd)Axbv&SQY$yiV8a}S^Hig`3HDC3nvDqsA?PBKQ=HZLo-RFmmX0zUWUUjRIA_}rc'
    'ZNGZC!Xnerb#HKwMQTv;FrbC|&!}Yp`Y!UdN!&5;p3^2FI9V8xx|80_$o7XL*_t3WyNua{8uHXwd=tV^(zM2&o~b-Dhg4%nD0~Ew'
    'Iv5BwFzkD1_6DAQH2>`3YYb(sVHq9syNS=33d8SRYF``ej@094`|2@oa;?YdYN$>o^*s)wtE0<bp(I801UI3Zl}+hZDT7978B7B!'
    'su^ukk@9bwzNipYVTWW)C@AT-t_WQ0D!`T$>Z`U%Sskk(F;xx-@*hX{sS<cRPORd}JVARZlT}`ov*%Ui#1t=Ux2Rwa5zW*mqBIMH'
    'et>+q0WKW*yI`FPky1;#G5G10)ll_KDF>Oh1S-XyFQ~Qr0(wgNtkbF)@a_Vm`sIhX;6`=r*B$wzPF@_DdsThf?8f1Xuo$+nqLp;;'
    '6lc#RXrX+ZPh(DIm7=Q+T@-OVAjrc%c3K~CE^xW4#gkdHt(kKm1l;sctJ$w=wX@ec>_(j&ZrKye(hNB{@`gfZVPC^)+j;J*D|B>z'
    'ZVC6x<CC{1r>_n5-t&vafa42fQ9OU2yoTH=r)L*&xYuZuUq*Y$-Q_|nBUMk6qG<*D_w{4z6BSmBJ^?7H(vAQ~A0@m6dixe-SM&1d'
    '-TBeU>(k`j`>UfXGo9q<)w`3+OPrWNzEIXT)6$05|9o_DadLc79(}ucpDkS|HuM&Zj@bL;^wse{jxWuYGI1`P=<AEK_vgvg+11h8'
    'nCMJtBg`UW4(tdj2x*iMM%ez{(Z#O`6n3KK&<`+eCB(m)J1V|N8`cw|VVORL6J=`w74%*Yf(FRfgP&AgE3wvHjIPafbtXGiamacP'
    'PbasN6;#}{5SoQObh_8T_e0EU_?83YZRbHg-PZ4oH5)Drtd*%AjkjhizzM7W+DUDD?TRM096>xNIA3%S7b0U!f9)|(JVu9eGJD~m'
    'MEC5M>zQHOY$HQ#Zrom%eOqXVP6*W5Y(&`257L*H*lVV*hS!l*05nhmkVgvG6sbUizr!EIBPeNLx1qZASotQh@?~!u<!{guu;w)o'
    '?y?zYo9~rQ0+~R1{`<TSW?F+&;xIJ`RNRR)^?P3M?4Z#sc>3%`QCmZi%I54#IS5xne+o*L!AQVLIO{>ElpF-q!L;!R_Q39DmH}#7'
    'GilylXa<b?P=s#1U%>;IhbK><zY-$KjN?cNO5Vo=R)<k`RnG{Z(`xi0qv1hU6k#_tuR1`ImnPtLaAU+NWL#O2@vQ4V21ih^o^GX;'
    '<RSEYI7wHN*<eMIbBm%F5F>$eN{W%<<~OA)v_T$=$t=a73LD3AH>1kKE?J@6=f!;5TM9ixU-<B^s=)3N&|KxPQSBD8(In6_o@%xB'
    'Sj0l+THVqn%j|oPEV550U~tAMHlss>txN-E9ka0RL%HTx3I+MY0y&<*O`kMOT>oY%f+i^n<^AWRr3to|EsFX0%|iKl0en|+$(!YG'
    'Gwo9Gd!4i1Lq&5u=<b6>2GV09?KH#L&EDHXG2un4xkqxsrUk(VVRuVpfy40`@9sT}k+8Q@?m6`1F1rgJEJt-TAco8^=!3xle6(mz'
    ')i&SrILof#%rpF2n1ST*n`1{sfk#2C=77@P^@!YTXg)m91C|w4aN^AGkO$x9kJdq&{0~j(DYHwBZdU`x=Ig3HgtSeMIkAi;V%@y('
    'LYyAGJH7;-UX`Pz`PeA{A%V@LV_4H+ctot#hK{!1U_F?J;6PIcev~t+{M^3}Fu4nOv=z)#-&VjTWnVtR#Gbt{ox>A*--{;XeR8-9'
    'Ow|KFGMJ^_$ba<+D<FP%^K|s4HV>ZTrYbbI@smblx4FeP*{y1Ly*%gBbe&MuTFgPa-PU{ky+Eclgd2!FOp3jH->!PJ9hOSLqxitq'
    'Fo#k6TT(vj0v2SKSrAMrLFmIUx#<WwxuU+ynPSGcG5?qFFk*Fdg!|Yf<PI1aBd?OPbC4~M-u{~zj@{S36|mGfvcv;qiH;=zL~NBm'
    'TseuhoUPe2KnW4v?jo0g+!wpgo^$g^{k_$v2!#N@@U8k$GTRO-HWLMCl@$j6f$pqgu5yHv$7uj_5J9I^!%V=OBKOaMX+~pp3np4z'
    '=$Yr)Y(6*t+4dva7n}u43s;KSuUUjnaslDeG?<Mh7+O1?jHW|MR)rQjj1GY_#^h1}m8znhkx4nVsC2JY<QZyK;HOsri_%ebD-JJ9'
    'F#SZ6#eCg5Ls2*D(1*q8spcfG_SZ%{<FpP5GtMZbkx;j#Ev>|s@Nknpq=U7-7k+sMBLh)p3^N=)*<8^(@ASqVZTN|Hz_WgTpbU@Z'
    'DY)SoxvR|U&%9#i183##gcrxZogDxD7>@t=;^^w^A~|_=e0p_q_0Qz|=;{p|#fMpCVU5j@4sSjli%nTgCmUe|y7DYT>qhptTAe4U'
    'QZOYBQ!P@@ny0=3IILE`q4gtnj*G1>cm;fzefSIe23${8vGa3OE&_v_(cmMS^eY|kO$Qi#>6g_Qm}fxNFkCLSf~a}{IfSS3=6{U7'
    '^dLE8omsjtdeZCWJQlAZ+YdMkK}Y`?R@?ZXH#E(|y8Hx>1#WR`{<ZpSbhpPAMz*M#vr1t;Z;p>%h1SK9H32Fft-Z<GGSJo*4q)^w'
    'AdhQ%@wBQBu<601I^h<UkgyxO3M^s;33pIy(P`D5b(O`#xsd?!VQ;ETQgjs)=hPv5QT?>Cg{e_-`!Ve)VJKRjx8xXA2#f%+Zfe}='
    '%5SNiLP{@8`b+VO&a})(PVE&sgAOOxz$S<@4`Wuo+qgeGhVS*$+3m*e&pNuy4MqkLAzC3blX8uxZfop`g-}$#{v!m(-;lm|YPwir'
    '`CCer^)#%aql)zFP;179MV+YEt|z>u)Kgm~yGI9)gRJuo;`SSSRvrJno##;aq`6<j78N)KagKX-UzJ4A;<uLtT!5W61FXvqh*5m$'
    '-PmA<ih}1hAFs}+mAMK#8SJjyKJ$Ln=%mlR+Z2)otCS{`>Pcm1Iy^j#Fj-W=N64Ss&R3%)^$uD7N*uh^s!Dc(v?)c-P>f9S)8PH+'
    'gm4W*!@?+?*b{hGIvx9^feJ_sT|(60U(8AkQ+W8q%SJbJH!}e(dsMc<mC<HvXt>^}o1@LzI2#%=T_P0Xh1$ljjdimLNUG6e+oHeQ'
    'u1t==mzFpXn@Bl}jwlZnf54fr2Dg;l$tB)(lqDiwv^V1%w>B-L1UT7TNCghZk<D_3e%PD}m$;6W0v!xNv28gJg>D05$Nx7%QS4?s'
    'dOQk;S?Db-4@QY&p0PS2<-2W<X*&mE`1-qpSiA{mV_C8<w+(4g85_K{MKV{$#6sD;MrGv9)=Xe1Z|N>_`3bA`!cd5Sk`}2TnO>O}'
    'jo`h~K?&ZA!q|kO(^nA+gg1`Om9jwu`5O(vFf<1UKQsT|Rxt&gF8zX#MGi1{P(08>f`McXHX_K)quyIUk`hgl!N1~QzurICACAx_'
    'SQaj1ST#%5<RD-<E&ErkI3hxXp<uP_%~C`#W@}RcjDKOglI%=XF^Z2CwWO3Hm?|Xc^}!X>+zx|OAzKj`zvp+?HxvfRl7fUAeQ(r4'
    'VW=bKMS!(3$U@e;YI{6crYm~xNMME4BM83jiVcAvWtrBJ;DfTy?FTBOjt<oWr0L^1OQ<F3gcw>emk!~%!Tg4{&@^u}RQWq58~C4u'
    'OyMsg3MuEG4eO<8-=}wG&Yz4(C=bY898J;TZe#bL)@;<8&#xMd7XIH;{MSZwRdD|VZ|%?=)@xg^NtFWy>GKj~iGre^`=*E<U|vmZ'
    'i~GYq6$bj_CZwkL&pSxP&`-_UbfTNxdc#I&qhlshZ$n;Me=5MvbYK@`M_3<DXMMV8KXS2o1+0EH(2jo!eX$S7@ZRM=a9b#ronox;'
    'Fd`c+lV{B<o99eGo}aXy&7bLomtZE1uHm|BZLoxE(6Cn>Zu)2(KG|(cO_I{B<@$G_RD6RAwZw#S6f<uq1JUL*@M3L)-r!^DL2_S3'
    'p3H-fDk{<z-^1J$nF>MqJEaPz6iK;3fv66hMmQ+_9TwRSY}p~YS7A4j2X0dcTGk;ZY)SbB44U)9EN2zz3NBs9{oBenkXd=da!C#^'
    'n0qF9GKlB$2$Lw7X=4sjfbRU~5D_pMR=!X|MC&;3&Bc@CHEN6eNp?%mVH2DX{F`Hngn6V3i69^QSGY71<iSvrIfbofO&*feuf8^+'
    'xp8~Da8(t6|MH&T`}=yATYB{K*~L{@+;x8XWFN}z1hO2t!omg7!1SHZN84Kuoy6tniY8iyOvq}MHuj|266bZ|=HY{n0;i*Q1;>Bb'
    'hL`tIHX99Yv;if%>_OX>91eECX-mFu6Tc6jaoikP*bL1KY}tLt+&c?zxl}f#PN-YVR$so^d{w&{eR0d*mM06pe)tO~vI;i^{BPt?'
    'O8JK^`4p9uo$7C=noU8%@1fwX8WInnSjP2UWu)9Ti}cv0gas|mz(}7M$zR)4DA~7{8;28s#}7Qw5uwupbdTLBz~sC#8z{rpSJkKc'
    'NX{P#Y>PnW*ORwz71UaxiGtUZl*K`CrBW7u;3*Bg61__3+L{yRXvr;Dad1GOM6NdDPh>Mut3Ry=WW+NLj$Zy6fX&HOAbPyb&dz@m'
    'zdM@;SzBTOZKYl<gOtT?k|BeeDQ%H^N7#v9$rUZie4(?`qQ3-X%}gXcCPpJC<KD+nA}XWrQ5Jaq5D(BCn5&-yNi;>`TR<^ntpZ08'
    '_*tUV)4;j0w9f;D&-Qn!7<`R_y`j+g_elC%Ub%v+wkbccRBtb=x|1uoQFwd5er!>bjLnHfqR8H8=khMj?6#!Yw@um!8o}<ZO>t7h'
    '^&_oQ=U*+&)=YU(a7&~k3iu)T%<;Ed?~<a=1v}Qs3Qbs)PedhfoXYpvRf>>ni2Ws?9L#U~^EB>su)H2-QnWIDgg#i5ve<0)`Ozh?'
    'V4UZ2x7&?Ssq-un5-s`Z(s-A3K=wg{u^f(c^!oVpDu7gerdQU<av|#d=Z!Rsn%%Bf+g;zO$JS6aJPp+|PeZj=Z$x&x<d1S_c=-MD'
    'F47tXViT}f9g|Fw*gE{v&^oN7BL!^&)H9Bjs8t!<1O+|XOhc}80ND$sqnXQrQ*A#mnKE$%1-5&y*NFZjD33CV;sCV_XP@Du9a;VG'
    'mzLqk)_pp-F;sxG6aSKBpq8u$TxEO96=l8S)+ot#8yP)WHFJX7t}K_5rhH*h*mDW;y>g;Z4<MM0J_nFv)#>ca_h@BmKGt>@UXRSS'
    'a_W0`QBbe}zFnJw!tdO!hXBIUCaA0orx9R&VjHoC9;o0!zUU1A`)2Q+6$rv^-1yF|1AXZ>yJgy`>UhP%q^Ct??WPh~@QGl3k{_+6'
    '6{MMHcast=!{U^x(8?vHb*So5_H)Y%0<y&jqBrIHun?(vvfy?I0J1IY?OGgwr8zk3EL{F}dH)*kJt~e^2VXP;&UWkW;sf-F9#Cwp'
    'O@yy}U7}SR?_ejKnqO+6d44qO4$EJPOBwuKL{g{S6Kz5k<jSsNA<6lk!vQ3OBYFpvDdC{?9lk^fJM9F>^v(crY?IG(C<X+)yft$$'
    'LMu!KGt~dGoZm`r`U*Y)i3uGoRqpyP`0WK2;i^>07!N~O8+ijP|Lh3)xtCs2d5iI#IdLpa+59k@fL{dF6^P?7Np5?S8I%}+`o7>Z'
    'i!RXhqviG8t>H7z;TI@A7WLi`!@Th^CeAUNTZ4&(mYajPiV+$1ioP)H;CN#AYRJEiVs3e(nv`BHXu+k@R5vj9Tr;diP{Yc$u4!~L'
    'nl3<^%okwX*;IUyD}|EhnW|onb#$Q)V^};9m+)TALyE?3N>Z10nq8hWdf3nH3`Vn00s1uuTuK4&?JrYZo&jfM=3<!kIvy-cEJfIa'
    '{N(2Ex-F>CBG-`1d#Lzw431!`)`I@R6?w>i;;Lw5nnw8B)pW3xOYu1!x`gV;Z`M+|$8-WJfeWZL0&2Vi@tr%sZskg=w{z2ko1+Gb'
    '@`FZdK$z@bqTnyev2C#&!THokA;L-X>x=upw1U6<_`}X!y4>kcW;<|3i+cl6vptBRfd74oO@rPlxW)RCGYB&tj(|ZkXJ$?hc*tQC'
    'nC?H0pxhGGV5Nbu(&q&&EDgYW=IHz+xjOsx_!M_(JiQ;Rs3-?!pEvkkYD;45kKsNSprtnGB8>uy9r-YO$G%DC$*i|XZ|19XhstFR'
    '=d<}T#VW&8&m|3LsixnP*(Wn$r~})Z!YZzpJp-<W=lw84HaNYREZV{A<Et80%LGH;Y%rNlsM_gL7U3mwK&s!n!Rgz=^B-pKQ?6$T'
    'vVN`hyV(n@6i;x07cFJE8Otdx@2Em#a1=1(OFc`0PJ;zkuI@6hClm9%WVhvdLOeeUYb7f&)B9iSMESok<l&R~2-_{@=>*DvK)KVw'
    'N3$u@(eQdS+>!6$bm@@c0>kmbPUFmhmVB78KayE7gWIsi*;{wKM}Y426B{9C4t_G8Q1<&aESl;3wdo_p(752_RXw;Etqc*MI+S*A'
    'Q+Fx@23Zd^Vx3k08U%o+3{?wW_JD~;S6f4BP4nq={uxlFb_j*4I@l@^s53MO#-I$3Q08L3yf)CfTA2fc>a!3E1oJR3JjFaA<|(Y_'
    'KA81jqXPzHgVlc@4a_N5CbPlx4$mJ&G`Lsf0l;TW8jh;DZPPm}`^(h8^ffdaxSZd^x3>n!CUDS4!{LOEhrh+0O?Lob4Jx_~7(Rw~'
    'W;0}Yn5*Pob{;MXB50^GJrfsXbn-P+;12!g67lox&1UlzjR6;5o-&cP54eac{{lQXo%HQ*;9~3#sAg|}%+ob7Z}bKnu)s_uujIGw'
    'W2yeUn=S6`FUB(NH}aP5r&*W#VI2(JqkH$aH{jiJYNlF8`8E5{-xhwzR|Yol&GE%?5C<8W%jDCN+z+$MtFw!v*U%K#1dJBywJ}Nt'
    'JJ|`en=_YAxt*BfMVtTyo($1=b$s;dtzi={x9({;Ne$Wnw4~~MNq3j0N9UJs&aSrZ%@A;N4{CD1s2?Mielj8wjA3scROLN7KQ|qR'
    'v)-pk?Xy7z3y4Fy`@#uVKFrQ9&aRGMLMl1-*o0Mm4G*60jrI?R<7bT*`@`p96ok*4&Edh`?s)g$Sz|;`_I3}OhrPq*i~WXa^G$d5'
    '+u7Uq@3=3skIARcv-{h<gM*K=!;jBzZ$H8J@O;_)eK>ky2-57!?(OWw5_)-e^pE7{e_r9&2m8U3pxM}!|9qIeJ$`-k@}CLB^1;G}'
    '&&SRFVA$M!K4|Rr`!DvM_Yd~>cK2SqXpVaQ;bG%&|M{qS_$;(vUY@<bc!{Mx;rrg;aR0?%yg%L_^+x@@=HYnwZ2xe7JQ(b~7#^D6'
    '&GEsD{_y#WXM5wl{=tjJ?z7%r^I2neV17S)uKN9V)9>lgThl3=8ABZ$osA}%+!|`l2%T%G7|wc@P6p`?a8o;6rH9#%p6mPk<P`Uk'
    '#F9|g;cNwAfAFlo|Kiy}f3W*()EFN2N6(+{H}`h?<MFt;f4IAQIBqr@2fO{f{c&S_Fn(c{I_N*|^$!o4yDxe@$%GRU#QSO`)Bm&H'
    'es9q09Uk^y44*gq!-M8{3_H`@+aC-Ldb=-n$NPsbo<AEsKRoCknl0ZO4qo&R_eXnsFB*gXFxx+QSJ>`H!~WjhXz%%p=ev!u+2Fmw'
    '!KinzH+=Tu#fx!o)Z5!{J{v!KG1%RIb}$+=o1?-0?qP4xcs4cw_@e(J(|xUZ_+o$eVE?eOYv!^CIi7awg0|hBy*TU-%=QfS_g@TO'
    'j0VpS4i5o%3?%K1#)o5b<jwJ6|Jgya-xxoGJ>4CRcSmNw#?Q^U_W)4gf5}Px0wiW5iE0a~gcqhMwFI*x^2T6~M1m6qHgAD-@SYLt'
    'OATCEih!718ArZzJr8;_C_qWseq1;UOORUILdkFfKVz-=O;BkV!?+Sga6el{P!FKc&SxW8&e-4`JPk6*tlS(RWUFX&rd@U7!7JIR'
    'R_iyTFBE~Pdy{~64ws~0MedkUc_&;<4UZFcbtEG@?ZlKNY)bBZ^a>}5;W_BsSJnH=8zmlo!_lWGkROxT-2F%=e~jF(TOeb}EOk!?'
    '@+2S4r9BGW2X~X9`*E#*keeavB8Fy3QZgMQ76LAkes=oypTYkQyz1!g_vz12_B?M2M%yNJImSI2TMZ-Ds)Wi9=5hTpIk~(zer<lp'
    '%&P$v9F@%o{uT$#10PQt@DbH72WBbB%?*QgbeO>qmo+wP50`xde5h?1i<brPt&q{TciZweb=muDmO!sieOk#*#K3DayDm^GnJ=qB'
    '9P4G!st`IjeKR${C+SN6(wnBAYmm$3cnM`E*dGH#6<|bR-eGYCkU$l?wCBTT!=MABQ(=SA9aJ{3HGAEG1^*T_=8eNcb#4e*@Tr$#'
    'E)==c3JGP0$JfQ|qPwuT|N55Zv-cO?>4-Ud^K`OIlbiYcV{9)tTQ8{vT6rzD!AcN#5j>=0kSHF5s7^u5#Rro#N$+n-m)XjIgqu5T'
    '3Zuwya(heBe0Cp(lkwOH!5W5Xm07%W*Ehn<4P&M#hn~$Hm%b$|PS$0J?_v&NdfuwQk1jQ^u6g3R`9T3Yy3!l22b<T?Ry=|gg*U6!'
    'A`M|Lir-PKXL@xrPgiJwH{#>h5G#ekBcKV*-NSmr{BIKpM5`Ho^T0fOb9Hro38Uaw=w@RVlmjB1DS#>s3z;HtSb<=A3>5V9d^yZK'
    'Hc$ad3h&u?*}Dd{0URBt3zNY!fJ>DNmK0zZ?u1oM%}?hSBMK|5_|irlmM8Dtn6aVMY|GJ>CBKqF>J()bJV~mhlsuGg0x6g0PX)zR'
    'HAJR>jzZ=X-j@R9vmm7Mi(uht&@KJ)*2o*l&qtTX$@`19aE=HYt(_fEwM#@>-4H<Kr^WpnNoaBNpVLi4yuLU(fAc@z7WF@#-q$Dd'
    '9qz~*0ki~L3qjV)$WB<qAkt_2fed!o%`AY&fd3TE+$!E+-oXE4>w6n|ve(FN3lOi-(%nu0m;T*kI!x$o7L?AH^Dp-dLzS=Q8fmbj'
    '%D4`!G&FJ0B8(LU5UEEFJ(P29MHDj%KzU&h6~B{G$LPJ|aXr{`e&!cEBo4yyk23JEw<0GZK(#P|fMY?i4y8hM@GeUQWnN#yBk!PE'
    '?tIM7znr6lQ@grfjDTD3EkIpI3VjNY2*M+*!&&n7$&(6?1jxv2?>BvBl+@F#S|xvRuNOC9yJF8TkP*43Fv3;3hCVlC`5CJp=m-yF'
    '$N(hF(!fG|9B(&)8F=)WX29$$N9h98R;@e_X{RM^>hvVv64wFqhjR$??}>S`-5?2cvbWDS74uJq@v|R9pkzQDoAem0=JR0MTV9XC'
    'f}Wtb89^n058!YNCoWEbz%5}^IhaU}G18}4U9$}oX<M`rIX(r)c>q^}2D;v730S9#@b#M;ic70&H5U>SlojE`@lj^=V4A^8jbx5K'
    'f+Yaa-f!%;N>}28De{$MJ~!K72@jtZ%);UUlFVBIWTAlq%<y4{&Tg<2KBmqR3!LtY;`YNy?|No<ipjt<ru0}+bUs1K7lToa2Cmk{'
    'v>930O7K);x~fI{z&^(~tr`%Z8u`Xput~_r)dCU6vF4IOMdmPj3kWYu^<&8lT+Iq3K-^`wQQ7Jr1_MIn?2<AU1}cl8#vHFW3jzRF'
    '33!yBsl9=BGpiL0Fd^>L$ThdV47TnVi%`qI_z1;zT9fZ;L)jX*Ad_@5Gqaoxc%;%zgezH^bTdrngO8(?&AV6Jvv#WDJI+X@Hec3k'
    'oV`>?E=n-{-vfM(m9VJ~EE_@ciRL2~i}>jL{CgP+L_n0df_VrT$#JMpgK+0l)9{0fbO&$@*nXa>naJ37R6C%OlO|%RtSslBO$!6%'
    'qp8dV>6AJ_ZZZKe9u17ssrNcU2&Q-XIdO(qNdPb*HCT4w2|05wF}=L$-Is%`SqqkjGlNCDITy=9Kv=&P_Wlj!QY5@MmI1swVtR5z'
    'NL)xpQa7JzQQZYYxqXz)Bm31Ec?uiSyfk<t7*9u|l{LJk)A=fGv-xXbnDtR44w7hB9!^s9!wtBWMnDmvsZP&Bc78V8WSMcV_Q?6s'
    'OGv<YaeR4v@f(#Nxi~w!D!yPGx0CJg>fQOPlM7%RA#<7$6^uY(q_4R_D4tkBdg2;vs<{QOd?Kj{%#1;g;2b&#AmFhzIKfF_oJJ5X'
    'Zthb|NvbxSmYr9qfW22RDTa)=6pI1rGBDo5>NO(SQ^<f9h;ud`Ox&n?3T5xRtm?xy(E1V3!)2#z<mq04=7XnRqL`(PP?>*hzMg<~'
    '3FJC$b`8Cm+tzER?^>-{gB$p}7UEJz>D7!`xrEv2DdJmA#zuFmN&gre1viEc*H}e_260E3)rE0WHw^NfK}Sn4=&#HK&`2N_4c9d$'
    '$px})Cr?j&{kX_|0DWYiGYED<GL=EZD6q4(X93AM@jp~R0)9~K3HWO@|2UeJRZ$2%fQ07YZe<7=IKJWUkCWLj{Fc+h@x+X1L6fh8'
    'je_qPJ?YpPcTs)S4851I27F<zZ)R?~8O<IWqIS?~o}>Y8Lf3obHln+xXV|r_fkeX^Ow76R+(B33wWtO^1&uY`_#2q-P}+I>>NU$L'
    'pdFNXNL_)Ne=FcRNPY+CoAVeUio#@_cITo%W&EU>RkKJ*??7g8)oQ`GnKr@GI9S((Pwx0CJM$Rb7W7X=x3fr`Vj_|dZ34J*<p8N1'
    '4aCtOU%`{5H)9P(C7s?~w}5OYTN}BXEw9mRRyAKth5@t_|CcoAPmDx3yS^lj`&;lW%+Lc+nh7UG38*4`#u~K9Twt6|*rNG~q655a'
    'V(}V93J7`|^YPbjRr;-GpHs=|4>?>q#~qmtG~Z-?QhQioh-6UKU(6fn3Ai1}Qbw%e28JrzJ-5_r5iMY{7%daiGU3{9YE>wW;NvPF'
    ')Cr5#O+Ym?2H3G0jfTNZw}z3qTavGmo1!=(QS0nH+1CZ6CO@;5LBr_4#|RdYA8?}Z-<pveuEWS}6g;AUwoN4hit=(PJ(6LW!L!s$'
    'x@QJA)AQ^xI{DfI4KYQ0HVonM*)U`Q!`&0WA%9#$J)tF#Y|kNV4Zn=JA>*LaBLFxxzr##-T{Xwd_%qGUkLu&Q>GT#d)>pz#ul7fy'
    '_M+B(YK~<_J<gy<D&?dO1-=E29Ky5drDf9TC$<0w9Qj%=&+x~K(Qv~maXHum7o^qw@HwJ~1#Q4t!ELsyuV8a(cuBX@mvHgDoC!*{'
    '_{6`&2)_Q6xSgc9Z<dWUVg@i3u-ujs(EwwC>>0j3zCs>cF6{r8-re5zmiICGmy`5~`L0c)cM|?ehrkvo+{tf}hZ$rHxN)~AJYf=b'
    'YL0)3_*6%GkBcMM3@2g9B5{asjn$wCo~ZG-HQJid7bE&7&a*I)w|bO3IpeRzU6G#4Q}I2tsAWDD*?^g!xLK;o0;l6bWr9orml5N?'
    '3d`t&jq$tz=3=_itQo?kr7@pxX3L2Y@Hd{*+Uwl5Sgj<1=mOKB-EPJ#X^cZep4(=U+hUZ~>?doEL9b6jU-h}f`iEJu^#x7*gNX|c'
    'i_{ZvOtE)pYE0#n2VW$5Rk3{u+881@hK;)&trEDjaKOFQ{B|<14t=bPQQc3~Jo$)tQ)u~|FC_9{F|j+5gAtvJRGfy5oJ>0Or{K%x'
    'IZ}a-Ex;y!_G555SJ-R-S$fek!pJ#+bsq-@ZoJHcx#4|M&u_dZmi9<`BozZiV;cI_`#6F+JW())l7<X&qHqAO;aVR(fyMbcz+eUP'
    '==K<#-t4||OBiuRv;$-b?Pf_{c&ML33<&d2P;8*;VglnGgW~;Cnjw#kt0ciyoYb9bMQX!%a<14u-{MZkU<YAO4X<+0Aj)d-(@)^e'
    '0j6&ZA0JG>azNW;`58IBjCKeQ(Q(TdAmCVKVT~DmFjHEH&Ufr~VIPTL92>q!K6*u6(3@Nj^w@Qf<v4f*&4}_Nr@OOMEITPPE~Syi'
    '7nZ>*RL-d}X-;}b_G~O0(Jmr0An!(YJPw?R{grT_Rmq$<=0(kko-lumc$?<c`O2P>Mr0_NBgl1NS=~XI;hUCrfwZn0HTTk=fMyPX'
    'd{CQ?yzk-+n;9-E+o;p%Qm?#@((PXVHLjBGJuTF`!*oLUk;^ikNu`5_;2qL(bd3xcx)CX$u+NJ*&hFQ}Z($S^b%l-y)q<(f`y2~~'
    'bJ9ciRx8u(XsF<R&6UW3GsQ+SdPGDu3^V70qLuf}<d0Eu-3KkJ61AvB$G+`?1|*W@@LeF`Q>BF=&(Q2;Kws(vi*PzAkeZg=5H9jj'
    '#`u#0qt!9Yf3G&~em&TS6QPf)s0EwNz-bRBi^J#cEj^9Bn}^RrUmvR`g|B%|z(T=WcvOebYAgU0{tv*2JP*&*GTyK$86iO1HAZ6x'
    'V`l7o&%ROI5Cfm)uBqD+*^KcBYP60DJw0V>OskF?wTq@8SRX&PgWwyra$DFYv%OHwK`l1BP$&nZkW)qq{8+r`PyCn)H3e9y$#f*V'
    'tbZ46BpCq)+Z@0PEw>Lg4)1%&AMTXxA=@P=eL0S#VjHnqL4IdwsQpyAUuXeU(<$4wK<P0bqa5CK66?p&J^N&0rX!CGj8;8FwN>`Z'
    'kxf;AEv}B_qel*oS$S2Q*jHkR?I;>$nxZs_9U<a6bl#1fy%s8cJK4R7N{C?z;{Z%wUPDuW-F<vQb7*v{+cs@>tHs06>)m2av%D-)'
    'GV}N5ln|$b2`q7ZuaTe@X#!A~aoexR)F}j@5u(YKr|3#sYiIsWYtKv}<F-H`<Li>mr^(pJY@;PssEB2#h~sPvUN+53iiD(OM&7DD'
    'qaDMj-2Vlt{P7tq1}!)Mr}U_5>5+wb3F95y2R)40_hMZg(?+xr#B>g)tAh!ClFmWr-douV*AX%b35#9TsPI1k4@mm+Dzf}$tlLFJ'
    'FGfcBNv#15BC-*vSvUZ)Y8S9DvxMkgzRbnz(G?>kvWzh7mj#Gs&~?uEwsEEE<E>U|z*WmTPXoxWoHb))&IiX($z^n90e531Jserr'
    'qrl$qSlAMJE+|HQ!o=0RD6HQ~?3f#d**EACXkW~f-it>^a|t~GD=*hCE3j&d0zm#SsE?SaILA~)>VOl3k=R0ta-Zl=(2`#vTZkb='
    '8Lxdx9V)&c^W}By^ngkfj<d3{ntc{&#wDmUgL30SJgiio4rj-CB>pIBn_^wkT0Ij-eJ8i0Tf@IlQ}2=L-dZcfi#i5&08^#}Y}fH$'
    'iLu8sl3A4{dJB~3FgsWj&I_DCWO1LEyZSM4TQ`FWkIFhmF^0ZN$dL`#9#TRBz@8rgVtVFwV0Bhu386cKa|edHq#n;q<sZ_zcqKs<'
    'Sjg`nvUj?gOs7yKIg>=d#bRJTJ1irM!!mVt29etE8IBmHf%i>-I!E#oW-Tf(KTv?z2zV4Jj~=_d<$c@duc8vH8Igb(d3+y*+02(z'
    'Y#uklG{0vS7TBt~S+*GrEi^900?w9b%jEjTJOYK5TTWdc1=F0nB}SRXIhBnV0eSagKF<yzPqANHj{$2zW81#HcWCmrf~X)FP-7tD'
    'ZHWy0oy9wzAO@tDr;GU1uph{p$rRl~W+5qCK3S4A!)@1uuqWg1xWRYyS>XO_vEAMR2oHf+B-)sY5ARtyg5G+14vN7gH3a)3kn$o@'
    'bEH;*ZNMRl5oi8T=fe1yNKnC1;f(sed&4>&a&H%SNb`Zh&0#ldzgqjT%wsl(TK2hbX$c(-IXJOC&ph#7=r0^}`5&m~C1bhJcJ`8^'
    '&lLrL4Rrg@n1@cmYH>1ATvD?}EG$$8cF-p_IJ<?N*6u+!5^^sSbJSi4vz@Xf%*6&>P0sR50fc+E8pU73!Qw7KpP82U(!iZFPgC=x'
    'S?Y#^v?sakn?`-ecB&{+*!^Y)NQg<1Nt4#XxAHPH@F6kcr6Z6X)LYN`9Nv4i<u1_e(`Y(hxXV=(JDfFnQCrPE@x}GIlH9Gz9Ad$C'
    'A(Y1%n1@Ib39fU_li&|ivF;;m_VVxtNxw10L^?wXS~fFCk;GiYexx<b>K*(|QZh4|%gJ;g@rf>*OU^Q@0^i(PR8ChzP2EXYrF+3?'
    'FgxobDGM^h#^&B))lIeQ5XA;SeGBkxpdKm@hG@JP!z+SK$Y`_L4EjEl7aV;K>J=+S22HIKU#AF1{t`?uW>$;&bTR<H8v`t%nXTFT'
    'x$uQKOPwe_U^PzG=FHoMTCV1U`4sxfTcBL|o1oxZ1nc5uZ-V%ss6PUzgy6pw<nBZHC)5-ox!kS%rtS^-oEdC56mS#kK`Gd=Co*t#'
    'zfA8#;3Nl_7z!BB+X?33ybn0*8j1L?kFQv1KbkEkgBwgEWw}iWMZBJ@ZtnVZgZy?d4d8fszhnNtc0J$ePv`v|$e$-htpwEDY5jUm'
    'U0n1&OJ<_~!`{1aH<4uNqJKqQeb-5;NWZ}tQ`xI2a8<LK0xnS1)5rK~$x_NzTb4AE4CP_??<e*vV#g~b8K~*I*6CS8S(%aXjvf2?'
    'ZR-EcToeM=$OZ$$#^-T|p_JzK?ny9ljg}lU;c!9cTJ%*ALUojfk8(z1IaAZ0Lhspvw9iZ<KtG3noce{%fMw>G02^hiOUQC~o!Va1'
    'OMV_STDCL>WL$WKf|t8U<mIlKUUf7y?bUT_n(JbV9iJHtn#hV(VtOX9j2#o-hUPJPN_=J5d3uLhGTAB^go%1vIs)Maxn_SE`>E=S'
    'rGP^AK7)}NONtNf4-Ds{OJUp}{r04T{`__ZrlQXQCx;aZ7eU;EZ?5A4SoxVY&e;G%8in;I2#s>?+<OdNj(<6&{wvNcy1bNb#STn6'
    '*4eup4Pi8Zt24BHk!h@>Ms{_Uy5*(Ivd=&dhlv94BVPjYra>+i;jk#~hotl0*gUGvmNSF4d`s|Z^KY7iU~K|@P6DWqb8+QpDHV_o'
    '82SL{6*h6RwVh`UI`k}Kx&tJs(<fX1n_TzMbI%lK%lv2{bS;9X3brN`{Zk|<d*X^Z{WQhaf{%kxZg8t?JRh<i4UqOnQ8M$>_bd3o'
    '2gSZ{{wu5Ycqsiz4cclQ4PQhXXX>@zMRwj?1GZqY1$(}-pC@e4ehEi#uq$vlbCqT7;htZJx4eSb!WLT3KJ5amqC>$I`lrG=tcVv0'
    'I|5DT-r=~$!x6c%WG;_}!(oN`J+vxa%fYx#9Si}13yF5-WM~OLIvUQKW}UO)c@Vk05x&_kI2!&N-%EzeDT{@<7H?1$mS&G2&vwUW'
    '*rA{J(Wz8>mNsL0wnuo$eTi6Qvsu_yp$`Hx*MXsIP>->$)24dVk>QEO4&RNkT<0lE#xrh})R8-bo-qaLZ`)Hq;ZV34I;p~&6RuTM'
    '1&q{?SPQX44ch}IFxwjn<+oG^*c>SsD#RS}MJ(zh_NOoPkUlE{Ffik4s@C???a)N`8>M`1c#Zz}E7;_K<FBaeo7EB|I+;@_bhhW@'
    '15o_cG_}_O%de*o_J|Er>XLN*<QvK%b(Rmxb1XuV9sNmCcTpYp`d4-`K|fKpETD&ZWpyWfF0W+EQXIQ=p#XD&X`*Vyd<=4dreZvS'
    '%&KwVxkuKmGsaRBnK2Y+wyGTUUqL-|G>42W43yRv5swq6hBsHRx9kgwpw-05f6dpH9dEWCF8FE1#nr^|ea;;KM;m$3g~`fOC|l5J'
    'i;EDC8E~rufkv;Kqy$rUg|N|Fw>xXf;n4|Pfd&7rG;74bckcVB1DzEl-|ZUxCJ_;ty5@aryxMZpkEh<tRHSC=21t|mrjJ)rz#K(u'
    'CTPBqOXyl+TfpIsaO^f@xGjKMGk2WtA2Y~7_pGYC_YqX}DOA9~yC{ham_Y{R(`j|x1Qf<vc4>xJvur6~_NwJn@d8H6<v8zlqJaCJ'
    '$^>x);*sO<28r_7k8BDTbgr8W$A*GpRw<rBjU3Oj83h8^s8(BYG)%R@2wc>oSj+!~GbX}Fe#)f8A30}oLcaE-G1NsD^&QUI6WsH@'
    '*+<|pBEwG`2{;7M1Ub7R3uJ8YDMXAvmS#V@i=mj!YwCJ|S0dG}$ikpr^yfzWngTu@zdlu8g%<)uGrDh(e0*{mK29(j-|jrVdGY@J'
    'wyk{Y6xkT_h_{NXST4&3(qgO8V@UZHBLIWmsc|zQnbdR%hN!>bL3)?7>x&9+3e)PkK)ujJ7<b6-98Z2*phJK-?_h0mb1#~hK@py@'
    ')2^=|p}`lOI0&xA{)3VjTY|y#RLKcIjAL*TSz|wM6Zox#Mh+$()ko4INnRt^<U>RBnXlY!{os1}gBOO+(LIReie^GpSK_Aj`ww1`'
    'P@k^bFLBQcJaK-uroCWP(YJ~3B*<(Hh7qBDjFe!ZgpxbYh07s2QpV9<NQrmGTY86U*I1!fX%oJ@7I?T|$4l@SmGTYbE|rSAb=-My'
    '8e*(CCZ8GN>x>T}0bZXVYEw4s;;LBGJ#!yyIkIJsAb4TR(<((gZQvugu`Q<Ky2Y8dEfyMh#F0&q^-p$o4UwO-6B+Ima|n7DQeO|z'
    'EnzZxkn8Duw1foHnEbB>$2L}~A-rYJMn9Tejkg+nN6LR4_9(~KthS%C08A@W<!U$iFl9JRxBH^&)kXYrgpQeQm98M+*zb|vz$pTW'
    'FbC*JTnSI5ou^g+pe;SI1-kxCpmH#<%F341Y{__fk^eAA$*^q-Yi>qH<9C5HW`_rZ!`{*E;rUVjyuZJ@*MBtF8`cjV9^M~3*n2eW'
    'J$h8{_Xm6R@Srz%aK3y0V80%o->>)g1`i$$279|<l+_B3S%%?r&D4{@!~Oo=!=s}IM-S=;j~@09_YV6Hcl&$$z1;_UyAK~6>^(dm'
    'JTU!&%n=WJ4|n&E&iCtsg9i^Eoj-WE>j%b>yC-VHqYaZ?8exfoiBeN(-<%@gDro_9whzP@afLiRqn2{k)J1~5&Q*7nslw0M9r?9M'
    'v_RK$nAAR8os9RQnzNi=n)2RMkRs?b%BUah)8b;pKq8ar7CYE)aR@j*e~OTogrUs)x`UkD^kcCKVnqE<FNC@FkLfa5?5vSJ4VV&z'
    'Z>yF(*wHfHXah%?TOz#)!~>8=rJ)_+JQ4&(EZO<2OL)h30UDxe*=!<5j}9I^e0X?p|1j7{iJEnWlT{V(A3eH%fA?tb{_f$*onmIY'
    'f0en0)rCg%)28LxB0{?5Dk{VQwF^hBQj2R}u!mhd_3@r@XPQ6CP(^i_D%^*Q-YkT`XAP~B)v}y}H8OjSyPiqe3BBk-MikLiy=61R'
    'Nx~<-+apg|Ri{1RfG!GJAPK-B>mz!!to6M))Mg$)SH&H(Yvz*XNqV@(9&wqjWZ1-{6lMv8!)p3gm@WNnd`+iMO;f#$M7n0Z-kE8t'
    'R&gT4OmE6<2Dh1255%0A@}~?B-SngLT~I=luV&S|u}QV<ir8ZzQm9+Vut>_Ao6Fe!m92$tE$2>6Xo+?z*u|v&0C!Wr4o4px(2>NU'
    'd|Z7{y#bUhG%DnKm8A*mHHoON*o4$6bb@wULR3#}$3V)!Rps}Dq;|9HPpzfY5)^V#@Jcd93%DUN$}&-m0I?g4R`}Iv>Wedo{(G>y'
    '3&r+#QK)S!{X^?ucQ@%mG_QeC;5Zl*LM$<Kj>QP8l2EUO>I$0eB1j49`yipRh=9Au1L}hay&$`NSRp8%1z5RUTiQL&nX3|vAAc!O'
    '5LX?2F0VS4=Swh1cx;u|TP8Y2+)=ELHU?(`hE_tst{+3jtv+#%p%;eVY2SJQe#ujG32-ffS26>)v0EUoJ1vUj+uRudM?a3;Ny)IJ'
    'snu8W%}Tgl<-D}k_03vssIxI0t3(Bi@mR-MDzfM`xINjjE8U&G*qKQZa-@s89hM+HdHYy)hxwaov=D<k;8#(TXohF+pta+r(Uf<$'
    'P-zdFUejOq!gt+qsGqKcodSokW}4ktj<8;-gJk_0`aNBJqc9O6TnaRNQnyNo{Lqu=z1jkQZvDNUPwFuxBFFsNEo^LokY3~7MeC#4'
    'Lt7+`)Ik4RIQ@&(xw$Beu-CuZUM(awPg`q?pg9%b6?R<J`$M(ybOkzIPWdJc$d;70qP;DlqEQm%C59rjJ{o#r<mx2MM$!&zIUVYX'
    'jhnZuqNN!+EG!s-MgBOIQfFo6%T9py5d_L9$N(^8B!adqkLdZ&1T2^*jENpxbZZym>A4Lz-Tqz-2UcgUmy}a*Z%f#*tg4vqf{92s'
    '_5JpshL4+@N|}RQLrIY#OnPo7(<L33eKQ%~K86TiYpkRV<3xDL!<6&jWh_c7j@(7=`Et%T;`wqe&P8VfP7q|NzyyM(+LeZrMt(3l'
    'yyj|IkP*3MlP7H8u<f`n&wFWYP@g8&<xb!}nG^m65?VrBvOa2;N$-iYp+8K)=viM#g&%J}g(V)DM(?5!ijd`FDO@l=3Z3s#MBv{%'
    '*Y9My0IX3?u#77*;1iODr-iE4Q9zaMxL5YCGD_a2V_~g^qvh*#s&&;ls(N30Q?04EF$*%N)YNJ?6})p2c&t=Ug&WV3mWp;`s1TuH'
    'l9ANc7C3B_1XM_<r<1HU2}NAhsDn#Yu6kzAP1(wWtRiSCXjbN3Y+=D^ZZ-HSCByOea=7n8_nvQPcNMq8e>cPHMs`iPeAlyYqTQAQ'
    '$dp|ZBEmnpL0Lv7OqzbbSMMG^INCkj-`l%CJnS9T`}g<n*XM)#hrRyrey=y&?L9htxVtwzcyzRP-tQls?;Z3W4j&EnkM{a|_w`Pb'
    'MmV+k;nDpENB7OYkiI=mZEkAq8NO}r(eC|62YU}691REe`{(<8(}#nDdT=-x9t`#lhJ*U>px=LZFxY)`G(4)0dIt}W4jv4T&b^j1'
    'bRM$8?>~C@@X@2A{`tcP{r#i;^IcQTgTe68{kpfe`(U_#aK1m>@9p*XhkL{R-lInkhWG0S501`<yASUl7{Tpx7(KVrG@P_K!#e5c'
    '%xJl#y3niEnN=DLzpm8QfxhA_euuKF!Doh5HRs~@<qn&rBtPkvoxvSTUV4YSU>=JtrJLEWJwvqXFPnZ3chAjM7(A%^j~*O6>OZRY'
    '_V@P(b$$4tUq3p3a4<L+_ID5V4iD>xkM?@~qk6v{?CqW3KdKMv^Zf^r(Sh5c4za@XaCfl(sMqW5J**Fp9v=1%dJp=0`ww~#>hnkS'
    'gY$!<NB18L%?7Xc%%-V#2ZwvRhv$#>j}G?k9}dqCa&6erej9tbZ;$R|%+9Hg)FiWp0`4KDY7b_qK^9Juk7kphIrxuu4|nhHnF%~v'
    'VVSq6O4yMdwdVsH>Dop_+0Q9sV!$f!=o1!0_i^}*n%Z&=!{YijMR!S3E|s;QE*J^sPN7d0A|@M`l$aRuov&8Ha+oQ<8qK=n-i_&1'
    'Zm29|cEySlI{exk8tGkFu5h$QX8lZ8b<fm=nCCiQgOl}r!BRO3a|YV%3rMXR*##}sXK-CuslyLj=9C4wJ0_K3A|1^cuvveMX<AO*'
    '8n)?xw_MXA{Rh~O)1<Dc;%NV+T4>&+&6ecgfcRm++2gZ;ar*A8dCo{3xw|JU(;~%Nu>FkfRi4_AH2rWrlXl)-4KkW<mA08*6J@ie'
    'Y+l~*6M7t2tz~XjSg+T#T-x+Ak-`eNO`Bv!tE}Mn7uzuJXrB!2k~#>=GgESW7KS;Ip1})c(k7R{c`ap1bV;$AZHcLv$&^^>i@ZL4'
    '&s-Uul%nb5XkMq3oVi;kcE`u`=%JToQ)g1w6s|M$Wj!+MtTgVMl+Qo{Z$VBDdj!DuP5uChFI6{*w%RTRj(U*%UHj;zq%NF)n}|B#'
    'HUsa*FUY)}$GDgJ6*`Wz7^cZi=EYun#}X*opz@F`ITTi_zk>IE0HgH9mg<B<lNSjMCa2%C?{)a2E2y7FQ8!l;!@P!PI$S=&mhs7C'
    ';4H9F6l#>JB7`{6@9vCpl1#&~66oZQN`bKn9*V9%;Uf^0$s(QDowE+$iUh;vu^hxa*OfqF@hh<DZZsYddj)8yT&O>reaC4hS22^m'
    'rCnadCgA;DX9~N)Ya&szmR9U##9yQ?oUC0<zRB1&h%5(w3MrZ&(1Z0I(6|M03NfsMcnX-u4L6B=7<rrVbMh<eI76FTL2)bV_a+3G'
    '!#tW7sl@BlZg$Y<B>g00Qq%4b-_p0_&kk$Ceh(L9YXO5Cpgsb_v>r1OAjeLjvjmhI&U-jHi|x>NBkh@yh<c-f!GX-}cXp%*of}jP'
    'Tk44HrThhD<dGi)B&Jo~53#p^2ZglCU7)=x=(yuY4u{`x^4f3bEU?Ni!J9jUgOqd|xIxHM&IIoHl@wvpG*)y0Tu__nYa%o*cRhx-'
    'eCu=2tQzyI-P!@+?y~K=&IC5BwX=zI_O0CsWIgZTPvC=Gr5y?wB)w}FeI2}-bX9@}`UNKGK=JgAZPIBKkxqCS=wzyu${O`?Mx9ix'
    'sYw#kc8<T#V3T+`8;Hker*}^qB8KhGMmF%gHQnDvR+p>uj(8<jS*7o)1Qqn`v>Qn?U_^r-iIN`g;7GFZD6CYL70R3rjT!7fD2vo-'
    'h@RswQYe(=Ra;bBGUQU}yruQXuRt$K8rIVt0v7VKwgXOtAj<ocTgh6MglO~`qr?g@6K$2qYL9w@+XmGUj!hC&CBO1!4$cx=7l_`)'
    'knbt`LLA#7{3IEfM9JFK;5mdF{RTWzz^AYkMM1g?8WUT2A(^f7>2$eR&U-WTMU>;-dcN~YrDHMT06N1gs7{Jc$0WQ+*T%3LZL*C~'
    '%@OEq7~@OJW{`3@UZUJn<YGDk)Nanw0X<&an4N779fB8|aUle}&bX2Q&?a_IB8*?dZt&)AyLY}Y{aU*G#@1t`#igNw(}Ew{`_pQj'
    'jA$^L6lab=DDYoSa1cShcn2fYg8E5EJk2_?t_i6Q_urP8BMG!+1XT3_H}0wKvIjX46{G69OD=+FGxEZKn@>ok&QqyR{%tayqy{5V'
    '+7VM8-aqTmI{#*JiIu~;)**ITzJ8?%`}}K|tk<+!TbRj&;hMziCr|$lTYCYg36croMQ(^uJqMv3C>9(6q&LK%82NfWy}7tVK3fa^'
    'Uq?V{s%w=$9ADE`NYebl7u`+xzS*u}D@gD^Ok<!30og|TD`jF`u?th!JF1OUHjk2NTZ*^IS~<N*#?Rv^zLOR|NE4Vy2N<f-9bZo!'
    '>U6wRsGbi*D!o=<sFRXn$I~Y?z?Mjy#&sbofVk>?73M(tDv1-DjShOCRUnG{*?eL;)tEFXfKd*!5GM0e#aRebS*ajVB4$L4kCeMP'
    'IkA}qVlofT#H{Kr#m1E4f0%BH8AJZYFadND&+Cicq{#6lUJA>kfl$F})0uDvA>I69I$w4nw*+1UW>tZ&fk|3a?V^NjdJHPqWNz8$'
    'dUyRZe9D@gTbZWli@K;6Jxm(oC8<j>NM6Pz>}C}p$jil5SsKPKm=4KNt+Yuf6hq6vJSN!0otTgD>Iqzz6vM=-qAf#klX+63%fwH!'
    'x^BgC8CL*qW0gI0ibMWIiCX$n_jS>00z0n8z++8m|0+}3*JS4*ezU%!p|T_`#9BJizj9~)3*a>Uv}RfE!|&QxRKaMSMXa|7CsFVb'
    'GqI=NbP9jVptv^9V5VbV7!0-6r0L-uukI=o&#2cn!b}Y&T4hRFgJZPfnTyd$v54zHwTE-$bLQ^c22MxGEz{t6l&L2%9qV`>CA#I@'
    'kAk}XSRbS>^F#V#U!+WZU*KYdiV(`3q#Pv^?Wiz9cimebn!K7;okmM?<VsOw$3+!eY!-6&f6V$h^Lu`a>bSvlw$z}IrW45MEdrm4'
    '?)em@$rQ%0Pg7BdajC!Lj?#PI#ZpzsHaWsX{HwbzZM@g_@rET_QWus5dr=|4ZjqYJ7C7D7JL|+Cwy^UKcOiM68Tw_50?m>rzDYn~'
    'H9HZGs#U6ZePD_hSd{#3dhvbKL>Vj9bmJYX9C<ssFcY~j+|w-*jQRY=EHOD4&<5K940bZXZ<EILW{$b9g?G7zESPhtkeV}BZf`s`'
    '41aG9n4+_>sU83wS|2aXKRv5Vk`0FLMA)ookGE~^iRo~$V&%<x`_XD%GD4~%;io6xn0<{l*F@$+2fW;qig3!chlRI`82lJLA^c4f'
    'dQ}7{$tutKLNFSVnb(0)kd9;CC`hlM3ok;Ffc$B1W@ti9M2aY7DG(K9OB@CCu`}-soy_o>jlQW)y?t{&HuV-~ZK|wnVe>ZSy4KU#'
    '9lXXBS!OKHO;+OI>Wc1-Dwq@wuZ^aNpUclOx?ZLA757O;_Nbw)$FVI}Tlv8W#sfiUK<swD4T=-t#jp6k791X+fLm|s;mrcTB^E7n'
    '`ls{bgbSHjyWY~sLs-CiEXa*pqW{-A>llP|r&rORQ8rdo+~yYffI*%%KZTbppQ(yCjr)O58MvC!963L>^>>ByAFIO2P_AW(+xt^t'
    'A)CAXac=>sg~=%kKJRRIQBT$FqPCJP_cOD1Aa^204uX4gk}EJYi9=?2YM|d+)<+I@jOW~TtS`LJZUfT39WClidLHhT^LI`#47_QD'
    'bFkv4D5EM{CdB;u|4o`A8OzE%L{gB`8Oao^NG=qX`_!B+vN7|}=U9oQ=6*$jA+Kz6mLaY2bDIL~!?F~sc1YHh=o9Rb<CdFsPv?6a'
    '?kC^tJ(NX`W5WP5+^(X}O%Wvxq8$=DQ+6Hi2hy_+khrj(h-$Wb#<R!&IK4rS%AZf(ky##feBfw`ZlFJzCu}Xmih+RvKJMJ|W|9qg'
    'Tbs29hNz6mEQkc*+H9dEBwI2JjPqgsI9gt|o}D~-_5zN?X>m?{F?ad?t``q;X-Ev(tpjm2<EkdPBM_Pf<6Z3vWBP$*$P}=&fL?dx'
    'X?z@0L!Rz}swfh2>IUfw)t;jT^X5IPVYiG^J-=obqEAJz5NI`_KP4q#K$RASqy|*wQnL{u=}EhZ>A@MmhW?}*lC-1EIhte^R8m?>'
    'NG`>TPIf`iADa4jmROW%|NUThr}K-ndt2JQnecj`h&ts{MPh2S7|_CET-USq?)JXtLcBDLKB&pNHeq1faH)%|8!?%UtJW!$+Gb~o'
    'LD!|`3m${vAbfh=n~a90^jQE=fpvFeLBK>qPf#mJ_7-uv8K?w@DsjOm7GBIg@oP)zAbtO4nUifR5=CYn1Z1I(xbn)Nni70@H#kU0'
    '5S(Ey*}n<-KIkKA-O<rb`PNwR*SbN4B_dO?1N1=OKr=c2HJY`pj*0>oVSz~LK#Kx<ohIsY2)?w|B-vS)$lZh@4?bBglkpt#RYnI&'
    'dxbv-3+U`-$&w<@W@cfiT!WU#RoNRF5+djHvL4TB$n7-0napmt&A()v7tDV$31&e00e++t`HkSxB@a*RNrj^=Y%X?${;?;mNF0Uh'
    '8`FkimVshWs`3y^F;tstpYx29zg(Cq)s^LfT;I<8v<h9XyuY<=o1I9f<6em?lX%rRU+ut?&wXOI9{Qc>v{01q-gnsw>45HVl^Tbh'
    'ay#zUU|JLCBRE>MGG1Dltb**ao9k|<x1%VPuG=Oqg%ao>#~*6S=z!H~te56YTq(y`(rmiPSCf-GMDm3wiCp>-mgk{&uoLJ+S%WA%'
    '?%HO$ZaXCq=BNq2@y(Tc-HWp)+hSX`(yb4BMbd}HtMET>496QJ8Az2g>pB=MyBG7`WSPrI;8GTk$DrY9%lPr$xS7|j)D*9}Jg^Fy'
    'VX7^hWpO3Ia%_;6UCi5&CM>bH6TKJbO{`A4Z$cIPD>-PFvsAt%GR~j60!-aYz2%|<)Hfsz^yrCgcU}V)vWLVVEs6@A9EkW~oTYU('
    'A0d6RtDwFNCYBoWd1U-tMG2>(ZB^CMeiR)lbEn&I0xGwn#8X{P3#VK%k(xWzLMjY3#Ci8d9cP8jwh+ciuN^$ArnG@DQN*hlUK)iF'
    '<$IM*P0uab#Jb6JZ<1NNvg3=gZtK{~58Z3<v5ZRx8SYhX+c*t9dS`c~GC#QULl-owU#)?DZ)UD3mrTU7*V^GIbYo!BZ7<aG<Ai+U'
    'rlaD7;#=Gvkmhj5Nv+8Zmhm_4Z4E(J_UZ6G_!~<NK4H-=K{7o#;nl6XoyfE8n;9rX+N;*7l0P=c|Fr(nRCaJ1q?!)*$Qs$`;eQ^j'
    'j%#%}4b!!)#aHkGII=$jJKBK#xNhbi3PQ*a3T0<$%5uTNWf+P}9HZs5X?BaV_E(TzHCQPv+Poe*S4;N{CtNUKTmc6Qqbc3Q?40g!'
    'WF}>92-9S#d^dwPQ0?s2@C=i5`S_g=>}lug%d@?ys<Z|+xc=<TnnXuXb!hD7rW-UZ17SyZ?A;I?ar;3=5<{^k62wp_RQrk;r*qT<'
    '%Ewl8j1$bIFP`+&g!hm_9<g^&Y7bfA$Ib+i{qPn^Q{gC)B#WdQRFUMdxt|d^Lm&=~I^|YBdn?5Zfn7{Z-1)0!?{+t<ccAd`*w>`>'
    '8_@Z+Cd9*dh0W*SYjQ^tqmihn>@+PBgmFt$l699crznkvm^iBStdn|LQNx_v4s|YEIy5t|iYR9}C0$R&>LBc4h5vRszF7hvD(BVd'
    'WMPQQ+^k7&KJY`q-4v!UEjJ6bmv+J+d!$>fb!l%9gMaLCY!16fq2!GQ0dodmx}%BCe#4Wl(h>>gOdbh}N;tbH@MU%`rN(BDAj^(b'
    'Ts~l8y<{@9fJ4JanATByin9}inPnF3bIJpCa_c2r0&|rzaAKZmvq45|$=Y7b#v@3ciEBVFT#x86S@g^c8N@a|S+tY!Jkkk7bJFOH'
    '4A>-{$EvXqRPD_b;XswG(-h|=SD~y5+YlbJA+n`mgqTHAMuPhHx(}Bj*#)#;x10bpi-9mgTh^8IqBy&8gu0I6v=^8vol+kAA)%^p'
    'v`MLQn$CK@uwpW2GgGhStg*yyMw7hFRt7n;=#D$koCWmsFRZ7J;9Bzt0@$`dH%LSsxDx`jQTSMew`pdmD@U6apx_h~n+zL7+{8wP'
    '&J9NMc4B9!Jg7?w3#Q}w*c`c;p}h*`k-&z|YjS|}Pp}2-MoT==PUyQ{5||WlVFRbV<zgGDS@*L3y}ftXNvtl?a$dG-uav!2;p&uB'
    'U4{QjTmp3>7@{ABSbZWj%CXB<hEuEvEM_NjkdDVZw#Fz;iz((xTa>XNs_d8=RF6{ifw{{ZIaB&m(VyK=w8k+c7KRHGaU^Fq;6ww+'
    'DcAKiz*k(KOXVa(b?N!%hWfk2Qo3F<i}^WpV^XIqFv>IrT?b*9tAeLi?tc0n1NCUb5$Axr)!)awTQM0M+C45H#ypi~#1AXabWsN-'
    'cPaR!IS|<kJ?1Y~1bVuNfneA+7J&f(isMwalr<7Zt<i!AB27&+qD^Jnkj2xUbxLC2z!JT}ewzV(x0qINg}QY~`+)l(WRIQA-}l?$'
    'p{A-kPLZL8c=mkQ$C@$h%@zE)^<=ytR0;(w##C|P`8)}wW!0kfJlGDn$84<E#<Ac5zR^0t^&!>1YjFM746<KiW>!VEt4)>L*6fDT'
    'Ks!T6d-e=TLIcse6wqVP9lx@sX1z%Gw*MW)?q<B)yin-R&gG_AlJ}yKW6!cexdM9)B&rBFFmEpB)8({39k1;Qz<bpYy@lrp5dIH6'
    '%%t|y;sulk{Ur3=?=Sc!V|9b${8n}~If81cqwmVZv5BOn5UnHMmLF?q+X!T4hoffcdPALo5T2>ikCxA_XFMr}>FGL!kFDMncysdZ'
    '`J3l2f8J~+0$1<G(^am!{~Ow)ev^*j*~yEOcPA+TyynfGJ~J{Sn;e^<SK=pEg{gHlsRg$+pz~jLV4LTCu+fD34*kFs+m3o`0hzSj'
    'o!y9($p+8$D0UKt@+)1eO*etp$)<~7qf6jU7l1y_8`J;PRuUi2MoN*P`YVAU*VvB@b6c)C3yD^&dQlyHoeQ&JtgFu6S`*ed%E2bX'
    'TldT*`TTUEW6kC#&Z)=c^N|YzJ_D~C0zXTPMgYW)S+)Te<$U;0MzSoqiIijt&o_rHDQ!~(G=k2-c8E8NS~<q95L~_$N%|k+^S>64'
    '?}V{0<n%4XQou>2Ob-FoNhu3A6oeZD-sD;MA3KEU8#lZ@X$p<RdewExH82G^ZDe8z62zaJK?6NzB9nkXKUuh>odo!d_&1<4u2TfF'
    'L!3WInA_C@m9SSmtnfJE(E-84#=3PUV0!38!6_Rgoc`ctm`)l|K5Uvyf@~#X#Ofp?{CI<)lAGoPg(gFOMWPtqj8{84=fX1W7PfKo'
    'naRW0%?LBOrF^my#>l2TwLH0qL+q{1x1zh7urzl(PtChi@UB;H&kb#=4tpRlszzHh0aU)`)f1XrV`GYg5&rV68f{Zc&A(uuZoWrl'
    'mg7zOe=qSbzQhp@uG@s$ZP6xGRE>PI34o>gswuGM?%0+6t1rZ<OngnCxdHg3!q26dZ%Epv|0fCD0z62Uu1ydjT`D){T$M7Z6X=P>'
    'p@Df%`>X^k2D`AxdgQ!Va`RuU3mY2txG{M^1hVOS%4Fz<fD**u$rj2{dtt1Jb*XK^tKmUCoXd6Tk82{ruf($9(-^-}6|)ah+3TgK'
    'w)bYh^?ZEkDhn-LhW<Jktc@m^$S*@)^c~Sxww}R({91i*?s43cPglnwj@5^BEgk@Ox|;&Q-DEw2_+>;ZD4zU$^77r=?#avFx<4M?'
    'havp<<mul}UOuyrKBHp8B@-S^+Ag$qzCaH!vt#h@?I-h#8xSL2;~N_y23KddJDB#n-H!fryEhngd;Cqi=m`Qw|8hDq%ts|jnTpc0'
    'rAPMVGG!4yYieq1OTvRn#Pz6NBWV+F5`Fn*zQ^OaB|y9ze2B~C5@!$Y@-<6Mn|>^ZdgBkL^NY<sAYh|<u(cRZ(aj4dc_e6rww4k-'
    'l&j*&U@#*1DX?uUz)_#!(kwm_>V-lKD2i@#KxXOQ03geJI=#;Kqxt*#_vO5|#gYA^$;DP5yw|+i%;D(WjF;73b4}#wvPGUQ$qM#&'
    '?;ovLjGLvAYV^ik(I&gCZn-e(&A;TR>rFqjLE3A73XJ^pCNsH5yW-z&?kGS+q&o0FP>ZE|K0MQOv3+yhTU@nwr@IdycGmRT(Q*A>'
    'BmN@6lqI483?DMaJQ{!;vYaYE6D@67m(9{b@fdo3+Kwd`-|x>{+wBa;;DhsoeQhThhy?nNZNcLpiVurSF+*CQZF;c<Z_ZNstu$y4'
    'VYeWcjDB6MAil0huC)-SE)pk5Xt+!KJG>NH5j;i`&~+rBizEOF?WMBrJ~#vvtJt{>o*wNz+Q(9RwhV82f}Gn`<8c^w=tii=<Fb}u'
    '6{2N#p&-G~rGOWC?L^1f<?R9jr)<3`$7hQXcip?H4WDOjT}mIG$Rpx4>QV~cj1V`)97!Vw)#jJ7MaHEu4DWxn@Z6%>1QAdh`#1z!'
    'k*VIW{}ZkGMPJhr-n{C*dG?Ptt^cOKpT0SH@=kudeD%|-7cXA@qclyLl~C3C6a~%4rb4m<QG-M5_Hd9=IKr##x83J&-<<s1b|1<R'
    'X$t)3iHXVt7y92##-quV^BRVEjT=nNsgWaZ#=W_nTg*_InqZvd{$x4c9zq#2;*x*Ac=hz}-IM<?lc|2c{4w};P!AnwrJ0-WyD5V#'
    'Vw(xfUAs^pDCbE9_bZBcB#q=B&hdMZMiny)p_6~By+9<*?YGZ=es}Wbm$K!4KY#g7|9tY|%`d5batZnmR9EW3g}PiS+%xlh-PR{R'
    'ax4=wp6AN`61ktYlf7autc(Np@oL+zM$kxD`E>onf#m8`MHDs4REc1deTt2==EH{ZG<tqI=fR&KsDqhB(aD-yRibp1#baTbs0CWt'
    'dXH}>ywjwopNt52%>Bi54t{Qr7_vU8$O+Qx6`jwyCMC=(Erm;NtJP@~Bb4)SDInxh#pP1#o$WzQlBl5_Mws&gLWUy*j6H7H<-0*E'
    'hMx7u(?#tQO4i%#u8VO=eYLbp;zh(JXTGZk$1PDf6KEr#fsX5Hacg*!rJ4D;kEq#x_4b6YA%6p|g8zPJm{9)n@AWPJ^<-&g;@oU&'
    '{=K+4H_HhO-1b}hC%)@!+-DoVfLKVlf${3^8Rp?;()-XGAw)-!8x7Co9?9(H1PN3n9-nR(B=~MuP7P7nx3`OBeSPx#2-J8W;G4R>'
    'D_h?+Aq9PR-1_d%f7-cO%y-U56R;t2aPNU>7jf%e(<d#6zBiwL7)@^$kfaWyc4QWY<GNn*T$I-MV3=SpM3T-3rlosruPajLZ~cX-'
    'J$ZA9J!J=#q41U=@Hlteur>_jj>;hSeqzc<((&K?gmqN;Xo1-Nk*dy2LhHkx7dp0tWX`6WFU5nQWUrM{=epy}d7Mp;LL^AAZ-KoP'
    'X&t2HHWCX9xTZ?LaPCj1^MN^XOH7T&f`VfaF~#IZfOwnSw#H2QAe?}lp#@D4O}pLh@CHz2&Au32&!%$_a}29MqBiave#)vH_h7NK'
    'f1jHfKfKR1!tf23JRY4(jr_#OKV~WB_N)GMc58pI-pl?5%4B~`7hE@JidDrRMcP7h*EjTZwZAxU$Njz>*T1`8NTl3Pdv4vMTlY7l'
    'lZEr<9+-O@rU^Z184=0MDTEtzJC4T&?!N|5{I{=uee?8WLvLL1!+mq|>)Z9e?aj>z_<+JU>6p-qM(TS0YVC>!qs45x0BW;^dwV(_'
    'gRo8YJbm)|-LG%f@0HEl!n!L)HFiV%e}6rB`>s_r;FF00gMzo;oV@+@MdpKne8DB3zWVLt%|BafLN9eq)vsRs_Wb3~82*K61T5aH'
    'd1SWaf7KIs@u@gGI;ihI91I`qKDs|Rf{XoVZ*OpTus_^Ce6U*|p^KFRtA(0jBfLeJ$>8H-5~n|WoZMa?93Eax9$p<?Uw>!_)(#uv'
    '8s>Zd8q|*rMVb7*e?56L2PjI==l=cVpKpWyub}`o19<!7rxSee>c_VyZ_Hf6R2Btr@@$NCf#E{5+vj8RuCzj8NmvAUBYO0sWExOT'
    '7bPF`a$cAEM54?f923R6(#@*#BH`nT16hYIqP1NtM`Khh7gzOsQjg6a=Dx%Ko`adVo^PR>8G{txOs*z|j230uP(UHIX(c}=EUe6i'
    '8gn<{S{8$Kh5aNbFwgdblec9iZ%d`S!#I7M#Ol-Ma$)X~KH3_P|Fn}~_$i)r$v0L)7^lyZK7H}(*JnSTynOn%?vHO?{llzb*X+sP'
    'o<BQzV<thp{l}{}e>X3qLY>d0Wmx5&>!Ja9WQIklq0K-Mhq1!QXKuf=%YY*h>jW+y{7q9rEasq#N)M{8lxMsOm~&D3P}$*|v6h%Y'
    'ch)nkwah=&;GU~GkWI3}ykVCs+J)QahxeJ&HB`xLzV`gQIBmT*|69U8bNFWh|9pUdhG%ANilX#(L(yCGM<cMlN|d2eF2iVrmG{Ss'
    'itu2#t8nPCN(3n6BePAQd~(`4J1)D|R&md)#63v0fxHuJ7?z1KngcZ@XxlA*KQBu7X{LDGyFMTETC;L^EZP+FcS(8?4DK)_v+i9V'
    '(|@*+N5hUj<|o7P&Em4%d5pS|+eyDI&&@44nd(6-P>#Z(;4?VxW@n8D=%!(D3pm5F<F?I7>R)w9)@+{^W+gApe%|WC2`BdY{dfP*'
    '-uv$!Ya|P>ywR>SFZbVn2md*E|DE|Jc?=C5FgF?#uTqdsY1f^Vz~ImV5*J>n-aR|{?d7j8UX(23R}ZWRh2x<UZH^C(w1^MgW4nW;'
    '%)66cUcY+t<VE-8lV48WzJBubq=<J{d`hIL)LB7VWgmCqQxj}O`#wzru{$DCDM{*ABUGBw^rJ~&n)Q(4TcT-}6(~n>MtcMX3OC5m'
    'F#Hon$gQe<+#;4Bsrn6Hvi8ofvB7*TbR(MQZyET{rv}=3y!AOQlp(QL*4u;9W_klIPQ$zV%zGJL<7b^S*rKox6I*nh&Fe2p{yHem'
    'D*1Dpjw~#ERe^9Xspz?y_Y=cK7@qVOGnDT0m#=?)2mDF9csA{us~YIUwz?%h_U6}^A7OkOKHgqVufdjEY!C2L!`x57ts@aiZno}~'
    'kw<Kbdj7oyx=j0UdosJ8_u;Q|^V%%OV8{P1QE^z(uhG4oj~3TG9EZ8IVW}wv>jfyIR=2|CSTTzltnKCROI5`OQ{!}wLFZ_FU+k#K'
    'V%c*G#p5j_lrFa6WTYSh@*htw=F=<uuCdtc;sahrP}1z4XD6@ChBRm3`3bFZQr;;&9-W1S>(K=vtHmXpkkcE0<KF^{q#y)TYe){Q'
    'IXtd3FG8)T*?x#0Y}Lb|X=o8QAkvVzOScS#nvh(zqVfh2s$5TSThTxuZjlOut7p2fC8o8wRsPD5E)?qCPhS1wCFJLL_3Wfdp>NUa'
    'pPrw*c=opX6oPh@c^IkGD*;6LtkX7##-)qcO6`D;_;g)gpVxEBG9e->J?o$=WB2@ai3m6ZV}oyilhqqpwde8{qW_{fz|x@j%EP<k'
    'AbpF{Hb%NZS`Xa#q|D@M6$X^m)+(XMj!^kD2}aO5E=(oDP<-r8dJ|^t?N#quMt?lR?D;LOOvfjmV**2Dq!L{w<hkdsPSI1ZIBO$s'
    'i={isWPK=81MJsyj(8w(+CJ5BOt^;bKHi)`bMVe<&ZP%&yGkI4z3yvdY<wOWVzsF1f#&;2`D)ZO;Hd3$*=Ba?Fgs*8U7Vzlp}9RE'
    'MP53U%FrU#wFsiVMJtv`L%c@%#7$PD0an|aV^Uzgq0)g@I_pe(;0GZGe>uM8Tz@6&QMZQk+Jag8`Bg@GPsW(tqC-;0*Bm2U!{nNW'
    'hHwzYIY*FEFQN6;u(9q@=Z7Pps<-{|sJ{bj^kP9K06`Iz&QtaXZQ68|fKv@-9{0`HlHJB-j79aAoA(f)Tg*GEX2WuruT<p{{db3a'
    '1L}h5bS(C%kCyKrez#|kLIJibI9*@Y%ggD2(m<50Ys623e@L}nnbmNFn98Ct1R^tH+!#qc(f$+!s9VrxxDD(ND2Xk8Ppzfwc=Esh'
    'ZhZ<OU(q)ve1u7MggIH*AWgsXm|ia5`>^xZ)Kd5in?lP;6C`BjJIu0Il=;`w*&S*HlXtPkta#f`O$-Ma+f)Piuxa3KQ}GU5^ucu;'
    'M8L+)M1DyS_an~#-ljxML+Tfzy2DQ*#&NA#Z`~+_$L7}&1FyLfdSJRDBN%pFW8pDuCvh@!bI^e|8J5E5tgBhM7~w*1ZB3?Im>ATY'
    'UZUg+eEzgR{6TD?vnIHxxpbx<(bZrGt8pxn1g;Qv&&-sFpZmLNP{>SLzd8vE0PX9bX2g!;_|g?@w*3;<y(=IZRSpIP6|l;gu2KyI'
    '7?;||ov))VA-;Lv`0vbT6tY2=Z4zmDdrshu#b1kZuXDP0XXxckk(Zks))O$fmVpSMXPpd?tS|tPT@Qb^u_l4tqll077LOyU)>*K?'
    '(_s~k_6iv7jaD%5*4PwD+mjk-t^`>|Fi|DG=2&I<tH4~lJ*ev${J|wVD!i)!cezr_AEuJmK*p7`-{{BXN?_yU?)qXV<Mno7W6D4j'
    'AGscnhn38Uj@ML|iAs9!^PXrMbqNw%@|K}>K{t%Zvho>R6N2ff_9H$H_7#Zs@pkc|$)dTnbsB14*eePCiU<N}4k)c;*CifziX+sG'
    '-HgUIUmloax^_rlr6ggewPnU<xYWr4Y=^F~#3QFfXeHLr<uVV8Tf|%tB@$oS_aTyjTDYb&5T=euekP4|N<k<lj~RgpmpuT|R^;Ct'
    ')#zr&^u)X97GidUTQ1SY$gCFn;161F-~O$oDoXFz#A<McTj1!Rl@1vrgQsP-R~{o_<VSFM!F=NE%R|nQAo-;`=k26QjtMZ~E^X6i'
    'n-$&&FqHUO@}Gh@8KpRS+;XLOGou5cg-Wo8lI@?qf4)1GHV25f<p&4VzQ4cwxoBjm+Q~!h<ru;G)5qK|cXpfy&UR}J(%;I2x<t;w'
    'W@E}ac`;vWOguU|;ishpDYgUYq_{YQnDB-f*BODA^>wcEVP+O6o8rw;0yOU|K}hw<A!wUvwpo2hB@7%qZ(`-<2HLZF;q76sdvgr-'
    'HC?}b|9*QohJQ!Xok{P*XzSzUXfdnjTjQJGx9}*P{(tY^FV4RIEA{5sA6RZTsl`y_KgNXy|2%@;b(}zu_AjK9f$qx7#HXfMr}t~p'
    '3uzUXswvcWsmOVbiEXKjdS2Qs^^_wjW59P8)tgIS^y#yYk+M2Xk_KJJduM~ZNBY}T)QkmlUo&HqzO3$$$!PuNB8`3;ZxXX`t#`MU'
    'h4s{=yUb6qf#}Ku^X6jS8`Kb31&BUDRF&aWrb7V*homXifPinJ6l>9L@UnAcCPBo`ES86rJrjXNcWP0KH-(>5(xtj{h?-%L8q3WN'
    'Jb<ke*iQ#EnhF(BvQ&tWzF)RB5yL~VdXo|O|BIwqU%<&<G0oKien62X#SnF*1kq&IbICKB8_i=CYz#$U3lY#!bGr&xzzrtMb;Ot{'
    'w&L}GjXjM>V!JcqyVi@eNHOAp81NC6N48guZAaob9{aU3S#jwV+LRnH?Z^m7JzI%-gwO+*97<}}n+K?K<=A3wdAO8HP^F{!*hpi8'
    'bkB73hf=0xlEHe1yRow9@>k!&W$n0#HL1PohIwgjk}6|>*lDm(>-dx2$BHVFTv=e@Gh>Lzfz<?*Y^;rddbk?vOk}@6V_BfPB)hDh'
    '>{3i}N{=KQp@r_DA}n|7wB*1gGbRcU`cHa;SQM^q1GJ11+!giv>=e%=M!EE4EZn<ZrR06xMfFM5O1MTNw+zZ`S5SgFI6i}k<s!Os'
    '2sw+vL&D5%o?<V`F(qFGx!k;u)Vn~&kgub}Qr`Cg{ne+y#`;KNmsJB|W1^kEOozO0{uJ~lqAJ;O=~>~HVW-&@a<UG{*QrKS4WEOo'
    'TC&O(o5-c~QIa$%51KY<Cr%32AlvcKA^{bZQLQQ#SV&9d<uJoX%?X~#(FzL&JRK&VbrmS|CS{n966U2owJM3OmfF&FZ(KRkp}}Yl'
    '@${+m(G6k&C@;!HZDz%sT&eUf0KGsgfCM&L*8?L2ii1T!Awdi2EekwJBp%1d5}E^^xP5ZnC4?}vjkz#*N!S9F%l#*!J4~6QcbZT;'
    'Y1pZxQqr(}>#A`dgklDqH2apxI{7sKcVId#C^Xy^`0L|zennoqqNGJ_7|#1j^PKv61`Dc{x$v6+cV^?>t?9yYUR#~2w<T<sPYac)'
    'Q?4#z)x&~f^gk^w(UnEJs6^A8Yb_W%CHNEL<mx<G{@zvf+8I3il3M(UJ0s-~ORl`>-0ldj1KwQ8v3e^-sSnL0NAb}XTvAm+iwZZ='
    '&BQ9I@F7~zi#70P8%gaN{mn`LflCw~|G4KJB5P~3<5Drv_|Pz}2Z#|767IMCu7*gZ-u(8N1XciJJRJR=l2&PDw+al7Sjv~dY(bzb'
    'i^48+r)>TF{9X6?%V#J5(f#T9ixcNpWUJ{=`nf^<d!#D47y%jC&`2Mgp}=Dvs=U{tY2U()nmGw)hzAH+o&mP2?q9KEp=Y-bV*1zF'
    'zJJPW--f;da?UMHKp%6p)8FO@^$2Sz+BT~@znWI&ed=3Tr}_x(fhYo)yD}aaGDZxtp#{;McTp&M;=O2-@VH8oRRe8uhs9AOL=i9*'
    '-yo5Ia$#P;)K!^pgT6sb5adQE8!F_l?8M$pU&}$IRg4$Bt=CU_UTn>&2_STGDA1Y4JTrfOufrJ55=VecA9|GDG!X!`evN$7spgr^'
    'I%1h^k)I}DDcsEM8W3)`&p(qd4cUhk(ZWc0Ggm`)<R6dDwG%%G$@D@Ky4y+L1`T{RtbY4b%DoSd7Zu5{LKJF=v9+7a{yZS`a%^-!'
    '_c$nFBiQUrCL^v27@N@qvx(yCK*;sozxkU`*npcV;cewDvGu$1d~c;kr{eV#!Gv+&=qysHBH@2fYVj^|Yr{FU&QhcY^?cbboF_+4'
    'n&Bz7CR)6sFCq_+-_2>nZ#@D^Zw;}UUvoA$M3qa4d0*_k5Ze;N^>V!i*$+hk_WJ;l5X|lzq{N0ga7%Mi;vHRIth%&nGHzK1l$2#l'
    '5m{!{s*FEe<N~#s=6M5+d*tp6HdlXwt4g{XVdm&SkWT65-S<fdSYc#DEi<dDX#FoFEVRE%&C*hZw44e8#3L1IGb_D_w?C}jEuluz'
    'pCd>l9ibhv4#tOpbskuDCxoqwi6?g<zn4{ck`x)Nh<mPt%mj3i6A_z4K>q^oe2#PU$^!blLdZ(wrk%sbOal`<O8(SGs`x+=k*tVl'
    'L{L>yPv3H1X~>pq0P&kIvR%eoJL=mPbR8>9^l+^q*abjw3<OJJ8PtHx3GoI4jy~Q60KVM<u@73K(E@PINYoC>n&wIS6ckPk?=-0S'
    '3@{J*O;FF7ka5GC8yRUjo?h6K@vrH5%YJ8mcnW6hpLuBJhY}I0zPrb*zc4~xoF@D1UQtrX^U*vYx_McD>+I9P;b;3LX{GEKpvTO+'
    'wy0Ki$n1}M=FwYl+#WE%8{)m37WC`Mpf@vDrm4#dgZb6)PXN|bEG)v2S?aM;gdpM?YPnzs)EG4K(TK4va8H+Hsg!KMi-ZA|p=(&s'
    '(X!ix$nl|{LtW(-NH|=Rd^W4+?asEX#7n`h%9*;i!54oeX$`*lkozX7pvO;03k_kXt2E$c*h9l%gM1xmJ@FNsz20aH40zQ7bcyg&'
    'v~aV@J6*(_26KqAWte^Ci3*ke>=?yU!fzdQNEu?RroK$5-c|U3>;%{`ybC1E=4Ng-!TEG>OQ0N9&^g!zIOm=bdKdiWdvM?a#R<m|'
    '9>;7#9L0mx%aBVuyizZu3WUJjY?@z~+mmm2JB&ztq>YJVibi7xVn<<nPyg}eWnNF}k2o=%R9-8$bL<jPLU|;hkg??2khCS(N86AA'
    '<zTn<gWfZSPDl4@{d<3WgW+I2bn?J}R*FWXQkyBcq9(f322KM75=B8gcFV05AQb-ZQ?Xo*A=~@WE@nlvFz|p-ln-((K5x{<aC~b6'
    'w8>M1*wJG(-=EXk51J3UzKAtzefrE{f67nB)q{MGS#cw_&^l%^JFZbbA9dA2Km+WK@t-G?O-ZK)eExw;ZuR<rU}RXB3wN|_tAXAx'
    'MWzysXTLHV74$ptj^2B)t3?$A1o_c?ae{wBNOP)AqP1}%R*aSQ&mTG0H<PCCJ!M{&7#T);^$``2=6kIN4*>YtpM=zCh(-jt*Mkr~'
    'Y|V6=IPiu;n2EOY%3$nVC#9cHt@CEPuT{K#_vFpHos<7KdCHVWJ{bWPP;XopYYsJz$g`uct^0lbQ-!O_9&R^t0M+Z-EuETsI0#ar'
    '4d0$d-<_orXUZKR`zwD<RQ9?EZ;3CPgVbmuE`iZ{ot(pN1^K+3?&x?^L+3}T=rs6$%OA>l+C3@|Gc6!CNuR*<c%-JF9G@V7^nLr}'
    'mlLABm<eKD;||%G*S$VAVmOt_VEU0kuUoiH%@jbGH;?_VAt0qp2-Xzc<$vg{dFLB5oLM4aRcoy~F2C6N=CjM~U57*hm|~tU0$1AP'
    'y|U)LxT05Htzqwim(ojrTV}c&ZOXXD<N(*Z0%Nx97L?2z-H~!nDY?VYUby$+y0duiKJ%IA*!>3)x0$lD`Avm}B)*cHv7j0HWMz*M'
    '{BN#D-Z{)=lfUCh6!GP5%w=>4eOay{c{gr!LM@a%%LJ}<GhtQn0O_8~6hipiR)Z<pe)OI5v-+h3_L7rvA&-Q)0hncy!^S@q5+30v'
    '27!#~JuJ5OQ*BMO_drfexmTmSm^%b;)2Ii?gr13lw%Nl^ec*CwCO;t;=s@SAK4(wnxB_u;4nN4;&|xw5a>jaPbqe3<UR1<8>D+xb'
    '*#r^>oO#I<WA%DV5pI?UP#rYD1+>MIJ0I1UaCcM;LD26>zc-)Iz6knkv&Sa4hem<OIb(X;g0kc0_l0(4#Q9ertX$Y|?bNru<r2LP'
    'x}n)1yDJ+ilVvhOfjCxMfV1LkyW53i>V{l&yQjr3uYP^`?#YiYPP)IndhzQoCtbs*zdL#BJDsyjt#neB<u@-!G7GN_W-VaERXnRr'
    'mrbSXNq>F|X)nl65FHY9A2LCv_Oo=ad<!SF=g8g1-e^g=P1d1xyyx9E9hg}ik62VReAaaCQMr$oBh%C9zWTv_r?X5+T3Tt$KCmaq'
    '9qX9i1(=WU#uyE$Pnwhlx5uAbPg=x#KYjAHb=|u)V;qggU>uwpk~>;1TH;OZoQ(%JbI=L1qXdLVZHKkKyBsZ;B@q!1Rn!nVwY;o-'
    '9RmT6mSzJPKFJ}{Z%667bEo_cmw=ihn<Lqyvvl@Gk>fS{f_{u?E|->IliWRRzg4HSO=ht^SSU+LyMi7_oLivKX{z*EpuQfH-}$uH'
    'OPaCH)(U!GCI`PhH<F)J+h%qmxtke=OAxl5!?)drEj0b?NL`5_PJ3Id&F4guXE~f`7JYWd3@s4mIg?8ACiUa<vNvNojL%J4%s;Q9'
    '02F;T@--e-pbs^{1efH`rV>(s(k;eyJ!?xQ!_80%<<`d;5hAJCQ@T-R^XbLBcij#UN5~BI3RB-18pD1sVCJI49paut9K?d0_NF(>'
    '$J(?BW@!q_m-Y3`TcK;3ci(CF0xOvM2Jf<!gnF@99OD{Ytpr@sp^GzyqUR%oKAus1Vmi$D4%v)6!9MWalw7UiU-Wr}R{@(g6RrZA'
    '`Dx-DsBgBxISuxBJQ<;DZ@P8o<r@tBdNdhbV-7su&mneg_y!I|pS?bW@kZ;JH0{S~y!k!Z2|n`ueu}foaS#6v{z>_MejA6S^=(H<'
    'fS}FYotT;yMUhTu0XUgDtHtc&KtZ3EltX4-F}{zXkK$zRgZdXc%j?-r9!9aaH+NlAwQOHsnZMhJl(aj2i0KS10xHP3rGpW5i2&^9'
    'J6NRnz0hF)7E+cY7wPdPkpJxe0hwLfc-_E1_~u{Jb3%fejRqCvJ)A+>!xH@^!a0Fi+yQM1SVqj*Ajn?O?}GN8qk}swhE3b12j<U5'
    'XC>_Ebal6j9m)~1V-DS5dc6Zhk@4}WcbU*AA<C0?&tJXlK1I}onOXh1g4jNDp;K1lMPVN6-!x1}>R9Rgj-`t44f1*vKfU;8_m?M6'
    '|MvXlN%#3PL`*0_gW5&cF(?iL+8!<Ncbh%VI;Ghv)2>7{S<G2Aa45F}r3#g|s8e1TvC3?PDpz`E8(gkC5M~9NtWyGQk(>gbu8uLS'
    'K$x6F@{-`ClM1r`T&A+42dKhftuPl&`O@>P@qu6krx{4^VlrKf7Mw9orK*8FMhQ*;-3AndgPU{6Xy(Xbaoj$ar!Dui?34w{LzpyH'
    '(6|AV0aZD@F@ERXKsd+c&3Ox{8nAs{);CibP^Rvja^vB*@BpeJT_BDIM33|0yoXRm+|B|X^`|#uQWC>{ZrvCL3AJ73)#Y+IYu(@7'
    'Q-2>6s`GGVn&#erhjmQezyE#zA$Uq7({MedBzEt=GhajXhBUP>;IJ$Pqs0|=6x5f%5VXeia0$&AF7;+O9Q6T+LpXaZ0iPkq*TuB0'
    'I7(CNB~1@<goY;fI8Pq)hA8(!0yLbaNxcLPglE@{n$UwU!D+(ufF=usTC)NZKqkgX!aosN$`GdkxR*eWX5hJuk}cNiej4_3GNL&*'
    'G?aK@Yz~VoQ6mEE0wL-VjYBel|CTCC0&YB&HUTbjWdNze^chdlRq?gXpy7P<!pf{C9BN}xzl-Dn=#WRBEZ>Xo%+PzYS*{enGKKnP'
    'QtL?<A1pBaNK`l|Vm`t?c8BBM1!p!wEx2ah<jj38$5SYTT6YH87mf$SB$!HK_HaKK5^05k5yW^AB5d5J8hc+=ySV~dp;uKY)pFt^'
    'N1L58?AXga1Vg0saBTZW+PdxC^C)PUk!0WPDCuj9>6f7d3u_dg`4pTQR9VtzDK0^oqkb~y;{@UpX?NN5EUng}nr)9MRr6!>ux2WW'
    'X^x*gf74$0*^L*R)VQjm+|TkEFr(_Tiu!}C$$F=*qm8Cz$MH&!xzh9uglR#a;1ErHoTo<bz{eK)09)?@l1x|A?X!wqT80?vf2}vF'
    'P0M7qH>9VrF*f>nC)hj4Af)&;&Tswd<%@s*x0ljde!ct=(lXN`JDcQaGMrXAiFLH3khvO4`Ku~VqJ?GsDYBKO+5z@;I4Fzxc~N2p'
    '*r6m2Q|u++a4^dV_fvascmMwP@J~lsolXlN1co2S6il2{ZS-GtC7ppErB&{rq+J2bI)L7n>m}GK`_t<gWbX7Tt!y>UL!b9SN<l*g'
    '<%&z-`aA~55m`EVPfPZXH*U!=B{}_h@*huM`0H4DnaP6*26vR=<9YEF^K&I9-QVhh;A+zv(7@K7Yn)oUK+E~fq~9YE!A<?2!l`fR'
    'ndB*scfTP-Cr{tKdJ`N5HE77b{n%zDcDc9(z!8+8pwm$|k<DVqGo$V>j;r|ZsyDf9)2GOO_C9WdtLvP3Qul_dr$)tw9wtd%MT?jy'
    '`&hJmxcMCGvnh9-W28?*`Qj|P=)9_uvWA6RUnN~sRlbyKW?jicQPmPsVVFsU80xoPuEAO5)5*s(PR$w-{}Q9|yHg4V?wEpja#&#('
    'Ckx~qDTsC|u1GN_^H>QI5e%Kgwq$vu0o}-rXBEVev{@y3@pzt)g|oM+O&l2TE{Lo_ze|j;B?^d_3Quzrr?BE$*^QY5?+e8zXdEZT'
    'V7|B+_W;RBqJMYVGWyeeilMW6g(OKYp%1$yZxA89T)tX?_9RV}^Mtlo$+4WdPik|DUzl+~(!xqh_eDqd!rOGnMB5?8n$WM4XNk0*'
    '9^ZRfC>4MqAa_>+B&v=}eN)8%i2Bjk1WwYXyaP>UHvO&XUaCJU6(BBQt~%lA;A|w8B5f6Ob72&Z0f%t*5z%&L9}T5zOMy-}CfRgO'
    '1k96eI=p-$tu$!<yFL4ek3!i`x5`J}mHrbSX?_A~rmEPvoL<*EIEYxLI(5RRxtUx|rgi{9@aFpT>dZ}YyLkQN-QUbs{@bfxPRxIP'
    'e*W%nzy8>L_v-H_FU`*|{c)5wu?#Q94v=%K+O_yu4RSng!|KpZ$AJW!)Vwu4OmEAo`aoSTKV)}^Tx<HKTxY8`r)-4HL5fQfp3Uz+'
    'w;;w0>~I#JW;D61;WEUfQ>rECY|n<bsrIc)!2IIFHeH2q=gAD|)WdpZaO!FHY*BCJ=z@W%Y^>s}iY!j}jaQdm3uRs+^%LwaQr1pB'
    'l&YyGuU~h6eS7l8ZuAm1SmkzfC!<tP%6zP2H$QM()HG&|2rOX^c!jwNZ8t)#&OAm+%49>$GZ7v%M5olGptOBE1C4KGXGxNanlVT='
    'QTS8As<<#Qyh34kEATuxUu$m&CPXof=*}Rnhu1wrCq8T$mIM4fi@%*bF`TT+(W?<r?8FI|#@nA6C^xT`fm2gW!g#Pc!rH*VDi0(F'
    'N}B;ycODkj0LVFcOYEO2ZHL8oiscQBvC`LoHW6@#m;2BsPYoTwcHy-0wE~DnPhY+K>G{v*Kfk_wR~36jsUH6Q<e%N$DwqbZ#BWbt'
    '{CWaq0{P$$J32xp33fHxMf#T=+Sah46I=Ii_bxeflYKTj;hx1T0>~n0?SH%@-@bXFzY6Wjkm+FM2(e_F;jR)ij5@8*sRB@{#=hq('
    '><tFE80Hqo|C)cc&Ho>_G4#@i8k}MmHx*z4EOstO3+(gvC@+kQb=rn5R}D~4_X40NsnNkasS1Ur$&tp&t2EG(BYK8oS_X`gLx0GE'
    'KSbCMD09(072G=g>wyr{R&g&_-wZo@ukg}wqjQD=VOJg*Eq8dmPeks?lnrxnzy9aDzrA{C*t?g{e>!>l?(OMc&mapo-2SsgwK~y!'
    'ePbxO8L5BAfTbDSo)&n~@V(;MA{^@m?Nq1pB*yeS4e)UGo*^>3-+GP>QCMSkffZbPUa8|7%&r}2c8+D^yQ(Ym4>GW?!5a=Bhb|#f'
    'X%4PJ0*OJutSwMqw!qE@?q=-QM()SkttUpfm|fP_^}IL6>L6dH+5WAMXiglA7G~&mZ!TC00ybWfa%}?rGpB<9Wk(A*Yv-eZndfa1'
    'TjZux6Zhui$6uenc-DP(^7?I6>=v5kv}uR`*@aZ3FP{7}ECE8x-%eh<Hf-s7n<2}jri~C0qq^}u>;Z_u9c*SWV0A3DTbrTWJ0gx!'
    'H2!Q6KnSa<3B9T$S085)D!qhm!?Zs}tSgQ4xS0)jx|>Y82XFSyN+0AV?`45ClUiuuspMc1w>)H+l!r<gV&LRka@pfQ+@+z7{5G-z'
    '@Jj6ndAkUnl7kzofFn`BG8O+SeNdUm>!<{$BlG{I@1NuSg1r^(blAy2q=vG60Wr(&%??Qo4mMFMdu5+`(nDqcrcV>9y<{aqL=xro'
    'nK;d16rEL;ZkiqYI4qyKfYcXza2cULS-}y>s5Q05H`9ewSR>F7G@2ZzKfn6{Ry$&kd<!b)3IUKbp#1N4OYMHK#ug|e7ojTWG<3Ip'
    '2&A|uif#6VZx`$oi0;O-d7FJHJCN+c6+%0Q6hXJ!pg`!JR+Mj_{B(jB1-&|XQ|@^g#>XQ73hMT!*XFjD1mBjJ`;OW_0`O3)HbfG<'
    'iN=_a4OBfhp!#{->b1sT2W-8@Jp|@R)FCZcCj>?-a=n4?KGdF<Hdzo`1l)|Y%Jl(|aDhXu=L+W$gK1lBVVMpPs<Tgt4Dket6XtaB'
    'xE1O;G3dlhp?7hGFuV6!MaO&^dkZ`U>(b8q?`)sme`g+TFQ+&C%eJ!{IKvW|y&t#mJhk6{=dSRrXD2V7W1jKd_uq9wpVlH-Py;AV'
    'hr>lpC_vyL-`*`-)~?#x+ut?4Ro=em;9Ldn#=VcH^yM*EaE}VBa1jb}wy&X9{9NM^B1Iph{Jg1X!f~DV82~c{PPBTxW|{S3J2Nj$'
    'k#qnqL`ez;LpUSsbb{_#@N98=Z8)_nemqmUZZi2}II-CnG<Iw(+t#o`PHI-Z|E_m#R`79a$cFdGaA*g?(?+AfFT^n4vPSBmGs;5&'
    'G7jg5+_bS|IA%eyN!Vv<L9*wFR|-(sR#nT@0Y<%ESaFN~;*~8j+N&nbl{@2?J<pB6oo<|OBiBy{W&!QdUSle)XF@Qa*|~(7Sv8Ti'
    'QbnH4E!8E&wtDWRm1WDno$BdAJDQ^(I?ppqxngEs<9<DT{~dSn{dc8D4Y83#M4B1s8L;J}NlFEj*p|f|6h?HFb|>}6?xIFVOSZ|U'
    '_C0TU>!7}9TVL|ow)r>ZMgIOf^80@O9ZJtwu5-^kMf3Z2NuP4_*j#@Jukuu%Vo!5vGV5v{HY>j7osO5+eR0_ZqY9Y!IG;Qp&|pg#'
    'P8FqTK;oQ&2XV1w7-#sZ*b;z)qJ#=i>ue5G{rmR6rX%2SS-?V7*kW`s>5Z#*CvSc+zaK1$@_V5OfF&QMmWDAe!tkyz&v|2hW%5i|'
    ';f&x76+XCE>}(hJsG)m>`BTAfB8O-mn#H{^oX8G0$~-53tv<%*@z55-<&5S&7+x^rP|o~kMiU5XwOo2Qy%H<JhJqlMV(UNQ^K0|Z'
    'u3<6M=gGOH5S=o;NQV7SEToP92}cXFSeNLrRHZ8nX2lXgvVRncR>_S3#}290`-$%;c{kr!bXS4y2Dc2<OE#dK|7)}J>zzGcch_=v'
    '4SM_b-IJeBI(dgBh^eXU+i%z}t`fcb*#&HjJnf=AGo4UAsnVOf_~U`^sqg=mChQ6EkhkHMW#PAQlWu+3FG}m1I0K~!OdgKV{8<j_'
    '52HT+Hh;&m7_I=EExZ&>jhz(9gG=3pvSBew8~V);j1D)0-GkkI%+9AjJ%9P+h3RPE2HxQnVzJL=H^I(+9nW+)eWVKP&=f3Sf6)G9'
    'H}r3@OLa5KjhPp_s-C};Ozg7YRb}{%=TA>m=v<p4gU|`tGFp0vn`fK&T8pQ3Z?%(k&mVuUY5YBJ{N@I5pMd)Ls;c&|Rd!Ahq2`Bb'
    '@9=x;TMZ@FcGMoCkM@w=vsEqkC}8|NIY8<t9JU@$dTBdDe_aE!(VZ;lSD$~GVYScY({uUs+<toQeR}SFss=8+bXD0_Q?5CoW3t&8'
    '&ws|q%vQ^zPkcms;BN~1BI&lffVUOxpw44&Yr$@SO$uV?tYkOv;S|ttMI2r5oLdE2co$*CEGE65nA&b8R3H7CU&AdC^urccJ9*U!'
    '&Xe%3OSEkkI8^K*x#o#sg)*&0;4BUYLns9KXlCfcT2x(Y)(qL?m$<z8CG~{guE)(P8Oqgzq)7Lm%h_M?f`X4!n@FNkh3Wc&(&|#8'
    '65J6)#|YTBFHW19Oqbd;8L5P+ID`s!$#~iuEC^O!w2!*qWu74|8CskY85gplfD7-OvfSx|L}9ajrju%2PJ*2iZ3UDet*Ww2bpZ2('
    '>S*;nt+kJ^?{9;@>?S|tb+=!Z#c*CPE-k(ii#aWBKtwQcI0DEJo;c<OcHGo~=(1Dn7LUVVaw@qX16&j{#sHgGx2z;S;nbRFCoL(^'
    'vx)&+>{8Q5L7HIq*h1V8Zk?nQC`ya$0v+(-9IZ}jvdr5D&9Jw4?;#ZeDX+@QePu(UFmVuXJQ295DCIMoGN9vxu&Fb6$HR%*qq(iT'
    'Dem$^`Xz>m%7?QuSEUX0K~s#f+zNyQNyrNqIXLgLc~+D+&_nqD;rO<{9JkGcd=JG>3z#r-_#TV>Bh|V(nLya7W@jKY+=?(6co4XZ'
    'X*OA=EZ+X~?sbdY2~d)&2QEnhrxk6%HKH}=7(N0wA+o$}CL6x_o1S$_d<)HoZ_TrgR<N%K(`$(N@}s=ck#ryPVO}thP2;=>^{H<d'
    'NjHP$Fw`7SzSFxtA6?u`Zx)QdYnYhgYu*LD;j*5~&cz?!ltj?>^l+N8r(hk^B+w2jiKK%&TDd979;{BOL10HfG!0#~M=VoCVuN<%'
    'G-kgDH?3~ko>2Ltq(w-qi~b?o$MSERUFV+EO!D#_?sMCAbq6*xb93)$WgGLL>oI$dNBzQskqACgeJV!R*EdUuFSd8S!h}WH^}N@='
    'iqW_9dN|NDeu_wl{tDpCA2$IDDcmepTyB9;7v>l-BfXQdxO5i$ILD)h4@fZE8Xxf93I*vsM!~0p%44czY;s{g@Q9whbgf|!o>;hI'
    '{Gm~xtHgzDOXlzC;_chNIn+xaRig>e)A4QV5)4I*ProHK5^V8$tQ9KD6D*xx$dCiXXgD!7nM1LpI6i<DZ5Q7ckW?4J70okN^K~f3'
    'U^iqY*J2L;4Y)t#=d9@@-4Oaho7$lgFpG#;WgY&}?Cgkrgn!E1J~Vt1A0XM75o5O@U-<9G2f_q=eHPCgrT@#}ZOGxR$%6|IXr@@)'
    'GuCGX|82N9b0K{+jW?auyRvH@la_#h|3lffFJ<4>;CX2(ee(nb#U;2^K0+bS@h@|!`22>TgIbN$`kCNtM_Z6ZC4-J9zHD1QrZAa-'
    '9a*q!k4+Ognk4+-(zvCTIwgGMTt31)e6&puC=Gg;sa9=-URn*jw0A{0wx)l@2uHF^oRpV%6?w}HwdqP>y$zt4%tzcuh5dZ35^4Oo'
    'b@Kbnu%DwPOzhP$I@LdU{ha&)M@s<fLjh;eGCWZKYJB?`i$H3`OGD-WTi&s>#E_wtk*XKR7c&)}AIv)5fvaXPG`30Qo|KWDPcO+M'
    'eM(%U!pQbBS1J)HxelE~I!jhJ0t!__N=vUVub)2)lAX}GMp38f><F@C;^bgP4NV@bCilG7-d@VzDDC2<x{~wYW1pUxc8Ec&FXhXJ'
    '9O?V-AU5Lp%b%6^)h5{OlFefM9fIRM3y+-2w9vRobeast>r+)RV^jHw8{$*yfm8EGAZ+nm6ai2)HScXc`Y7=4YRVU$NG+zbu);{e'
    'm0HHiX|*IW+{;qWXAC!Rk;bXUN|NZ*`*%X8b_<Y#rWRQV!w%aKJ=d2`Kyw1@XK|b}+jfk%Sa&(qe#OV2PSDuLNiRFH!kcqy?jyq&'
    '8A|Nx*q%En4G#q2@$i}W9N*N|{lRsk6r~1qrr(>u`RI+=joiG&KPvheC6nj5ViZ_%K%*p`n4c4s2*OiQA{mxJ=m+s3^!J4-WV74w'
    'Z$J|Po{xSeon0}9Xcq$50Hjhr=mPA1#Tj*|$h`g+Wka<VBze!WQ$3IehB@R8ST&VA(bfPjRfOSjZ_wY>-$sHAr@@i=HlgyBWVVou'
    'Dg1qyCS^YT2%GCvu`Ukmn<|48%410KdK~1SgJOnN87x4?Xao7y{A@rb_-?>0?)TnYtyEW-p>6_X1t<#b<YfLqGzNfVjj8W)u5fl1'
    'Aga)?!@XH5pDUgGkEF4Kra^guXMnw+_;hSRk|+W4iGcNU+rnyrbd^3!+;JKa5m#-0I#soofar&=R5(Yr<mv8N=P?-PBj<1^3^}9+'
    'x7~BVu_y&!NGr^vNv5wXKu#sD&e%tKN%;uzC9a74Rz+yBr2zfPKx?~?KtQ`$z-RY&A8|T1U4K=n{D-<`Kz>o$Jwr&W1}~RBVhZ^I'
    'YGF0qvSG?U5E;#jC8k1w5S|YJGa6SVx#+aE8s;i9wF-mP&tiu`KPbX6@+znAVr3rd_84ZLK4ieSJYsnfjES}=sss(UxZv!YHGsJU'
    'Y5Y{GmBlthr%nd!c!AJdGG_V1s)Fp<wY%MFbhoe!Z+o+#N^7tl=DHP3c?bFx$nj%^cU&LqN$X@@Io)Sq{QWa(FT`AqlZLy)5&=hN'
    ';$7|XdNv#oz1tIMKV5#;=}aFFIQ;a%r)*keF9$Y=P?A}N^);!j!Aq_Qwwl28mVMm~=S~@4@4Ve4D9-H-`-B%`<#qsZ^G&_%jUYpa'
    '%aPaWo5L}=nOWc=VJU_;<JQ}EuU?CKa655H`D7fX9>gh1pERA1F2E1SC9UD?ps5_ELhoggeTolT$_tXp5&c#Z)lX1-%te!@`IPZj'
    '@886>3hx2;5&yQXC_dpAku+1~{_bw;hbp)%j4XDryX)?Jm=`;*7HKY<%RHdmXsqacv?>e~3_pEt$j=R9OC17_in#6}tkA&qAd>?8'
    '>mRUHhs%=lh69!&z8%F{Zi9%?zN&Alaqs$k(1VA^@Xx8$x(fTsA^>t_kS1yo^Z&x=syvvF;mRJN^tAg}vRlF|A<zA|<y+Y33*WY('
    '(wo2<_w9>CWjT0&gO_wRDqPy}%#ef(?qbvJP)|qr@Z2xXZKXyJ`xl?coWcq9DDZSX0Fnc;ja1|(nVl@VHa{=a#OX$hGvXz3IY)g#'
    'AHR%mAlKuSR}J+nl_ng&S2xdHvl6Q;rnDBBv%<NX2QneDlVwI$<}FS!Xi}-l4Q$(iA8lF#mCn+2qoO_AQ3K%9o^M*OYt?dw<hY$+'
    '`xyF1XF@kOsXz9{E`P)hm53VVZ6rNcrz_aC_h9w9ySw)P{faD1wj8pCb!bY}Ea{2;gL%A~oen$TIO*_B1CP}XjPYvDqXAZdX*ic9'
    '8l6$XA^KD*-@|$wom9}wLB7M(xpSK)x0!NV$B`fcjYTt}VgHDCXhlRQOGG%6@^MO3vb35}?7b9%Qd>@*OVpUyD9nI)UKWZPofa%m'
    '$y-Bw3&?m$OV_w&4o{$YljpMZCPv9|F_GYk$1ZSKQ6jCRJ6P+C1e1|)HwjGtEpTan^KOUa;FL3oKR?V1(c-#&B#GVKWmt4V-=9o6'
    'LJ&Ptw~i}8XeFq~f}1$FkvF{FOmk<!9S$r!w}A}&zGdLqw80?d^DEnx6az1|FU}bWiCbCkXL{BHYS<=yrm|6sP4IE}HDjsxS>Xsn'
    '#bR_ymP?!0MzuVh-EI%+dIo>AgStCSAG3!UHjI2@Ly@x8pWQ5~`<P~MI=}5+pI1kFkM=v^+LbhWmCRqT0Q6Kd5$uQstyOUc%2sf&'
    'E16i&sBiA_tI>>&en}-5tgAHcPIe*_r-=EDnNhRV>5QGJ(O6-@u|t@dH?Wze7$S0IG?SZ~y<qL*smly)y~(4N8>bFg+tu?H*Q94H'
    '8ikUtt{`Ax&FR9CemzRUN*JKuXS$K;?5npioq0_#Y}{9B#!s34L9|QKh;A9~q^~?Uyynh)d1W(q(W+X<S=1BSXdHO8E-v-eL{3Z&'
    'h3ooeLGjDO-uWE-WG&MNcV=|yL$#GiyNgR}^fG^!DEB(QWjc4ARRdp{fK$oWa^u+Ux0Nx<vqPmjQ)2&5ch6!8-sXPBDOA;3#u+A4'
    'Hz6;|;$~tUWyI^)O>jylt(^Ygz~Z$`Kh4o{zhr}w-p!g-a1fo=U*IYay#s_{85zd+wm(LVjM=`Ui6rldx*-%@Gtw1P5`U)Pd13<H'
    '<E=gYJm?x$I-MmxCfevdvP1Vvmx%$Qh9Mf2Ux7!#MeQecRZ~9~=9@uMmD^tAynAeGYWN`s9r`>Z?gpi_OID;D{Go~qaz0>p0_`?o'
    '6|(l*7*@*K2Jhg{bvM7VPHN-3Jq*933*hv!A3Ik?<5~nRJW7*Qw%U>V8m6QFuhEQJwQl{3&Kmljq|bcIIn8I3yGdy(>2wy9bc>yI'
    'JWDhe&K7ra=gHH*r+5T*#*#DZO@AahVA<?+#3)Xl7uwyn3*MQ^TkWi2wvi%oAHVG2#kHhP9lP|H(b_F(U3O>{MwtF#d0TYWzwkG>'
    '-<5+{wMGu)2<Ru_rDlB`z<aA&?W=Y#@>IK5tb$#;o41<h^)nq~N{z&(y|;IKmQxtOXR>`c5Gt{GmG@fNc(N@wkJUEpIO{D=f_6-*'
    'xfdP*gZ<Qni4q1>H?bZw3d*z$FPb$=C)E0X2`*sA8-x@>cN!{Ezu_9Q5|TMGLv1TW@AdqJW#OwnE+RiG&32NX5Y-uTd*7Gnl0+U%'
    'WY~6$5I?pt^Z-e1WJb?{35VF^yi`@x16=E@m(p}uC0vIdgDb{-u&7SY9$$|J)e1N7$7T&9MWQp}1a5IUY$@<<DwRcRc1*{UeS{DN'
    'O5chY+mrHQvJxu>^t8iS1T8bPZl<{1>6{i(z_^R~LwbPxG!g<Eij?(-0>c`aU*!;;`NTF{>5ZJ1jx*Mb5E`M~6eaHusUaRJ$3Eyl'
    '@v8DBTfG-BI#XnSS3UQX5mmLGcE@j;G)}@VR~6XFQg20zp<9t>Yc_zS0JY>ofK)LrTFZ4OaaOqG%8^Ai_Lj>Y+~8e(+Hk~Wp*B%0'
    '*|~(~ouoy*LDU7yhZA<;v?M#n_sXO{znx*mY)PA(<O4C0VWOWlzS362c>ZC(&1F5ESEqBjYcLfjQESTf<8FZ;*b~m)7-tES(88+;'
    '>*k7*9&mGKE-?eSCnnjmq*F={Wq=7Aa}p90!H-+cM_l*3P?wmMTv3^|vs9@dt4yVk_0%7;yQIA#%OlsaG$Y#~n9WXd7c_5K%eKN$'
    'cXT|o&t~Gy<T+TlL@5a4m>_dN+aPcZ*e&e2|K8)i0s^kst~LDUd>1O~;Nfq{(m7HEFPi+RV%Itjnv2~5z563nKm1`g25m9u;_CKX'
    'a9?wCu3WygQ;7gX#@a>cQS3_Qj!M+l#%@>w=!O2mM@gBl;d*T7u;b6qEOMN`HGZh1Yy+*kx8LA9u<<Qi7T`HHXsOUr7SdWaQK6aw'
    '4q~QY0iQaQ(sz96+tBD@8v^+90%W`aYMHNV%wKc?G_CZyRr0M|%4J?E>zwKi-&f5QL)3Bi;@te@ZZg+E>iShrftl+E=4WwKWrHJU'
    'maHhQQ}RsOv>E>BX>VGCn#bJ8)0iVkEOOE&mtAJ>lMR?A+`nd|dG-JY&MU8@SnX>!6W(ey9c{m!J272N)irTka1NO3u>2J`a2S!t'
    '+|AK0_(Qp@FXOPj3U~EwIIC~MReg1iN^dDOTe=NLq#HfF9H>deoUzXjx~8o)pAGCvVxhweXRd$5g9D{I-3)?^!kk;yy9e4d{LO3%'
    '@OQ(}e6cLYy#=AxwoP|SeS-k1gR_m^Yd+v*^6-@DL*5AmX{G#H<PX6LE?EYa5(;=JHTR6empU5Gm+Oq~Wv7{;*A3web33-yza*H6'
    'OiK*j5&6>-caARNzL_6k1yr;os+XiW(OX+h6M$kMnnJ@D=C%GJpbd(_%eLaKA$f&UlK#|h&ifQ!MWk1wo3KSSW!?BUmRzjV65vGa'
    '`Y;hTBTQ$tWRoBmz9Sn>hL2l92H`LSp46>WKGL{SIJULEGm0kL05X<#u=RGu=U&u;o?eyZC%k->y`8RK=dM7FM-ZN(Yz<x2#4M0<'
    'QlJ)3z1Ge${g2ee%0~#hzxPAsnIV3t_Q^$nAE4qqX?c*@a2>J1ZAvYgwnPX&=qv1h(6g;A1-5t5Ji2%~GvwjucbPxJ-*f>2kataw'
    'NLeJ(4v$oUGOcAkk6`OOwen_A_R!0CRx!Lt&8X>sj`;O*U36ke*n;d)D|<yK<HPe%=ne)T@Z?fZka5@QY=UROC?i#03Mm&~Cy{d1'
    'hY?b4NN+R8&O^>c!V2gGm4slUsWWk`0X(;p*)Xn_b&f35lsmI%?Lo#pd3s}8kEKhgrPbZFzBjhB5YkLDD^JvcxBd0RrUbTOYKfEe'
    'VULha#;!$#MsqiQ4QV2=YQ4#BiI}I5KJj|CR36VB-K(no<F7V-Y3h=gB|G@N^{Fi2YPu6fNW-17(Ye6yot|W`1MX^$&J85|;u#Dm'
    't@Ad6aoUzZ^3csP;ix(E&&sBS>}}WB%?v0mM?~wEix{mUcBKOsI&_`OnNw;1@>spAJn%6jGQ=)&?k4x8XDc%gMhhd`^p{GW_N1Do'
    '8y)(b>25@$QlB>s*HV)ZsZVeH^v*8X!9Jj#JG4MMxHJoBPx%Gf3%P{Xc7HvVioIj4dSt)LoP!3Cc*VNPAyJSnjzb8X6`~tnb)n&Y'
    '&tICGz|1Eu(~V%}zxCx=I11Vy-z?bI!QGvScoSLJjc*T+MCI;^U=m<+t=K7X)}HiM!P|kHjdpNsw6TLI<uA^v0B9gz1x=g0Io!6T'
    'sYveFZw8utSJY&i*~3RZwrk-);>gVg(zxtgNBfQ3de_pwB=ubz!VY_}1EJHiZ~)5HSYNP;s3`l4dg=<R>2=(X_nCX>tAStxsABX$'
    '7xC`A<T;nq4JQQC+mmLj<$Go78<_p{WQX8>DOtHu0${QcxCxG!AR@jOq^K^%Gx|PC7L7~+hGJAzZ_pLcXx$R;1PiE!iXa9(+wPq&'
    'rsJEX%|}bm<NRs>HSrSBB<A(a0xo=@gY|rVgUWB5?jGT@IDjs-4Y*#0s30F#nSf$;dAk7IE$O4Jq0q>j{1UMVG!$<uOdZBUA3+?R'
    'QbuLImw}@$PJ+Y|bRclHr1D4$;KU7X`U12H**2#OxH!yT?X;4J@^EHIBy^F{;<m)Sl<4DWVK&^&?_KM3de&AgrJDj9X;-0~angHA'
    'z*&!nJN;`$f%8+xc1ng_4xLJqtt7Bxy**g+y#e+_SEGBDsrIrS&+57EzMY}$(%@A2V@cLMsDZ~e6^!adWq;h_ZMXpMciJ$B7{|vY'
    'y&Y*Q$Zn)xPImH7az-Tf3uWroBpoA>!vyLY-ZI$9Z%*F+`r@6#qf@7(Z2jj=Z#)`~9QIq^P?piMdtpxX(mqYiAtTLn10Ty)I{!P*'
    'O_e;9-be+qbT(q-3=05H@u2QeZ+`6%H1tvKjk}5B2n}Szjv=?Y;qL^>9TFMRfIPQA##zFaj#C(oTD5T-l;H40fGN<R{$T7V!zf`z'
    '(EXb=<!;6mGiN&>r}u0P8PkSW37YZq)!^&3D)NHJf#vXLeVr=UI*wnrg9R;lAAqfl*UK_BOc--m8}ZDM>7Uw>I3QRV(4EZWPvRGJ'
    'dz_OD<1+b3n;!O|6FVgK8nQkCHh~)mF+UIz)5SMamvUYKpp#8?8sHS9qY01rL>h^;x10;pMCg$K*Qqx`9%)$zc-E@A(jTNZrFOVM'
    'h;9T_d#`o48~QBv=2u=&x)&Pmwb}Hgjtlpz2zHw-7z0T7UHMbxk2tX)^g&1qHe8u?@a71s)kRHvJ&j|gbL$a>OeajF>+OZ018OhO'
    'oAtIr$vzd_-%cu4=2YtLqW))uR@e}=gY!xL*jv;m_$R_iEbM)T;DpIgoNWr9Y=@25t5erdp(4S1)Y<MLCGB>tzUtP$Ym_`75vM^<'
    'meZ>mSXIOO898z^Hv%q_g`Zyhv-{-r^X|J>e?NIiFv$t>hhLkQUg<1^8(qO~0q1J)5{Yd4>66#*etmOtTKqHy4%FMIlsANWXjv$@'
    '-dSW!?~gDfH`N6-E$z*#g#$O8pkea{G3j_wg47c>%}o>+z(U^Fyv8#mEOZ)6!Yz4l#Z2w+>Q2b$^tvlLhMco}qDpa;`e5!FBV?L;'
    'AlC-yGprIL>8l?2I#2^Uynl1}2JX&Q{V~$|lK7NQg%MtgV@Nj-h}f_cqX|g!AR2wn3{>2JRFzltEql$?x5Np6ug1u%Ayf&zIDoM@'
    '$6qX&(JSDtK~aUpF6;i)qUhw@Nc0d`<t(F^O~<4DEdYv5rp4!|bnj+4?HZ<eIiKD#t3rwbN{^eIZ$>1;X#aD_AP+f!1sBPVF1*vs'
    '%#F;=N5NWE=pPBxsc=CMgy%|FIP6xzR6T`F=2e~JwmP_ibd5Uq7-Fb+L^(pmZcgm;h~chb%9YIBB$pB;Sn)c#?p-U>#~E2X3Xn?7'
    'Vx6QSQN^bPNj`?)1ve)}^j)`sA_eP9T&>Jnf}hc_9m&pU7!I#5%FQgm=13f$x37ME^YjFr2S>x;$|(iahelnU%08gcp2>zVZ|DzT'
    'YoxKtAud=Jg`j_`{oVUV5dc<nH3jqu^{GAbb!0ilYAL#`?7;a=h*|i&ix;PlNkH44KMQt(uZUppXjVkfuiy(`65H+#2JNI@bI1j-'
    'lpSNAZ3^$?zNsQODL#n4J}+!2fOFa$!pY@A`KDaBX1~7_<|!i6R2;DnuT}!LG5zIlyu3G7%&sb7N4)nd^$N+mhp%|zlm(Y=N9qqy'
    'jbdPj%s!P7L@{h^zHN2Qe5@ypB*YM@Jt=wY?OV|!d8&eQC|#11n1IIlO5!;p?cG&ASF^w=#a7NjVgz0yM%IA4R`gX^+S8D@;yQ^u'
    'EnUe_QiZ*_x4(C|8v{D74K|cd4WCXIlgr=bce8m{Txgp`DwE7NQ`c}nzU7R**&$g;vhSp6`NOm(>yT_W1shOl8o_3S8bl2M8MI)R'
    'Uzu+HVVgoIr%tsOGLYS-3;7OAWa1Dg%%@i6HSDgsW=v&OgMw8y4A<~xJihKN`<LzF!=iioWb1$Tw*G5(>(SZ0qSWnnED&b|IQ9Hl'
    '#M=p6m2f)VI(QjS6NrSS1ae=4(S<Vics$wmd@&o3%*g+0dbt<6Eu{XZhEjQxAxf}rZ&@*Jj@Z=61ho46fjddpd~{LI5kf|r9sM^j'
    'I6`tsmyh4AZrxoLY-;og)kWyKA*zl<MxDDN-r<>CE`d{6BCawBy+&A@jD|V~Sz5gnZ5mNie!8k}k5#p&=J%Oabx?nPdVcca+1v2Q'
    '$h~HEVESkWTn8qb15)@uCn~}M<gM!3^{5`#{pFTaCieB-hu&xmZZ%zbW5i9{qJNq*wp>psVb1wgMr3SGiD@YVn^w`YB9RxfAun8x'
    '(%(@rk|6n2=5G0R8j462V0V0^2;gCVeLX<H*HI8M^L5Ef&M%MtT3e&Z2XlRcmkfXTReG;l{&VX!c&zm~!QvDg<QD>G9dZ+o!J$VI'
    '=SZ1;Zvxw!yaR4kvY22%>=7fRN(N+C#*5a{HWcS~fDX>9T|`>;`byqtSt_pu5|2LXoXe$8x)s=q*%atp?i$6P&>_y~m-J}R>X>}2'
    '7)ACcD^NSDBRK+-1urz(Q^O=s9>HW4zRa4h#qQg5HOb9wIxm|e{Z(=Yb-os&p0x`?^jGDhdr=>D@SV8nXKaI^P4LgHC!DvG;o>2Q'
    'h9m`V`8p6v#DxAd3tY&BOViXcQqbjcv7I|5%95D2AgWIm^>R=Td*;t}Yz7s3f%*zEhuXa8z42I^B4ye_PA=<sq(9<W#?q-7SGGHU'
    'nf(<3)Ijh=>}<M-ae7D_oCLe0DBUj%RXUFNIH{Fth<m~rCD{?AU2K^;yG19{H?Ad1L%m$%Jd0thCOnJ6I@tGZ!0P3|$5f#<x--Z>'
    'zt;p;k=ABjIpoGuytvHf`|sfY-WaZB3-c9n2B<~dyWVcS66+41A<jv*;27d__-igF$8gWMhqtN9FLH#n{&AF+OyOE)VpSz>0TiL+'
    'N5_JnD`Ial7q1hz;d@bXo_igAf=4qh8Ti+!vZZVqao?kx-U~D!Vta1KqcD85Ay+kf>RpLvs?bIkW^(ZM+VpJ5_9~U(j3zTQQJO)<'
    '&biTm=#?LH!mfnT;;rS*8+6^ZNJW~aP)cZ?#T%=B5ws)U3Mj5;X6I+R9FY!2wq9}uc)gjGYd0fUbuvwQPPQ(C-km&cGfik;TgDZR'
    '9Bxy=JMz7FSR;f0iUm4`CtC`V!Do7;%c3{7kMb+8xxC{I81`MfYaPd$q@|Uks<DP6BBg1<o6vP6NUqMRJhst1B<@RoWs&<!{)zCq'
    'G@$L#vc5)FX;eD`nYLrqS<PY^8E<#@+dKS<QHN4$X5{2cXc3wc#oJk_!9@6zi_D0B&SM3sxp&2NI?c4uRnzhC;X@P)zfwAxVGSU$'
    '+wbKu5-}Nw(z$@ov6GHkTdhw%7FVm#%DX~o1NgPlw_&>IP(ucb7;C{ko0hb?CyL^=0Qs_Ov~Uj3yiq!|CU)F8Zh=4#zBD@i&!O&n'
    'gYx%4LKmr<!g4MCGE;l3CZyzH{!?;wa$lvCg*fu)xfcuMy5{H@ENiZFvF6Yt@bPPJ_!JfZ;sn{Fl+#q4mTDu#BPtm;Q#D!=<8+PU'
    'LRC>sjXK6o8Em0}9!?lb=!Z<}dRqT0I7VJp4)z$5mp0^<eM2ZcWs02;lp{k2<Cg+;q=Ru&7W~L!o&&jx{q7>?zcrou%Gkq>sA+g}'
    'ef4Z!_6+MAh%6Ef8IQ=#AYr%&GIcb~oW}IinVI5RJWHu+S^V0n%5(VV<mzCkA<7eYCW=)!-XUVZd@SPGg_c5mv#)4ek`>8IyW8%Z'
    '7VVp+L?g_7hk&@o)VtED*$<XDhD%%{=NQduD$SqxhpXTuN<YH}p8T6g3GzdgRgi=S+)akQx6f3PiO5)n`Z$|At$%6A<8(Z|umO>c'
    'YVc??S#=!JwXA-dw`_>SVpTb1Ze6_>8bGe4@4$p|zs%?vgD5qtX7%WI#VT^ri*k}2+g_z+#A-er)WhPk@<e>l9HslBu%oIhf|Zww'
    's>&nc_$nRS#e`Oe#19sLO3W!xwwCkSh5@6B>f1_icM#$_o&wPY$3aX#%LUXB4hY6muIQb_=Jm&X92V6naCO^Gq(PVkz&JD94<;zb'
    '==p8HJb-CZCVVJaLa`@{#pq&^O!*;@f9f+zGKwF*gp3I)^XT?yfFP2P&E(|e)8{8|3+xlU#dv$@Ed8_zcWh|99v1<LT#gJaoMSk&'
    ';w@D<Hzg{56}n~^=z888cWW~<Ud5-o9?zl%rt2t|H?uL14fs1fZD!DA#^b@cJ9M|Vz~cdPO3=EPzhDM*E1{T=_yG0N>q*DV1Wk^5'
    '#$Xo9c6vK@08lijMo?MQlv=r7&8^vgiyH^Hs8mSVlLh-L0n$cWlFP)~9nWvcI_XYFDX5i1o*tf)&$Sqm8W;=FYJB!46e8n3BmSg2'
    'yqRF^{zB-DaDI^@w}rgX^3q(iqsau71FT0`n5SlV=6bnBP$Ge2Dp`d)S^`?`a(;_|o}MBXrp33*spN<@;Wld8Z_Nz?#fvhjRO@7@'
    '4Qt1OFQ#DK?`%MY03?!E|4&tBi-b~jrdZ{o*>^UJW%pK{C)=)qXWaQ%ZC*d0fgaeJKNVhvxS}kg9CGHFP61YYzJoZ5jfu6Z9RTE&'
    'iBvLW0!Oj*QNOI}$27+m#$B(9pZIV*tA`y9ATk79Xd8Aur0Uoz6EQ4cR!z=Ja6DQ!6YF#00I;wV%P;JB?vA_51^4#JPbb}zm%nvi'
    '{rL9e&2J}f*1qM!tHfU2*xFMbDz%s_$EET5(KBIZ$)|}t&#4StRKD=GhOOlu{#M(6*6TBLt4nP37}Ajee$ot5nZW>lL7<{G0?A?x'
    'B`B`DX5tN}3OI>o>3^U;ZSmS~$=d$~5b`l6dTCqqIYj%|5pRGq<1of9Qg$m{GCZqAPbrz0Yo8wGpb<_H{+cXCePnGl!VJ;opK%5u'
    'XWQa-VQwGLxZfB8eq(+Nj_D#W9WbIrYc~B@&$p(-;SRd2vYi`|Vmv}0Wwcs>SCB(|U(fI#S<@nmcoO)XjBa9<1SDN8i-qB5PU9Yf'
    'Sreo<CuKt*gO8I^BeL@k_T!fyQ-IF2a80mO{tj0?6HwgC-U8G2TIaYOSX{FSS$AkHX`Ha!1B9~K<<^2fKg$A3ZB|c+7KOQDzqCG='
    'Roc>G9<hhrX91~P4qoKF)yzg|XXA{zMD3~#^l0>j)t)7tm~0`|zz_)v9+s??Nh)PHM?D<Hibwyr*O$LF0NP_K8Kd>YQjVR_9Z1co'
    'pWNOe%AwOdUnA><IW^^D=O84VIfJhnUn@j;Bs@i6P{2>tfps?N6k~-`re&QngcXN+`}F$YIb?n)T@@sC-?554(E_42Ch#|=7CVmx'
    '8$q^0bD($_KS9bl%(a|aEUG+Otayr6u2h`sKDRDWL6sSWx|1Pv;wuHE09D0IrNc7s4b~wXnJio$uM#8uTYVyY8K=(vq4II(l4-PE'
    '$DpfOVy=wO+@{V0fDT$_m~oC!TQiT@B_yEvj*@x0M4m2%r%k63?CP*YnEfVR`i9e`>WLO!&jj_&=PF>;!}MjFh#4*^q#|?VWR^$;'
    'i4zO*uFP!+1~UCv!E-(KTyE*iVZe6;s^s3%Z=EOlg43l)33<|#tO8s07Yg(TsT4(6)-47Vv&wduh7t09hI^4jBK@l}T=q_5T5Jm+'
    ';6?o_!bwhaVD~FsFe1H2V<6b}$TvAaTjpDu)aE)()tBWl2(!?yuP_M>r74P$q7m>kYWD{|UU{@>dqfQJ7zE-!Nf6;m@xcM##8?Av'
    'PZhpTpwBdGGz!Cm9QAh(_v*caUT-+uee|&R=;+{ZaQNu_!O^3^qe1`C!JvP%e|T{J@aW<Fqx-!_2ZwtP?(aU>JKx*w?WNLgX(`2r'
    'mmb#_z5cC{NkHOf%Ha|-{XQFy`lF@&UU_tQE~hvXx)H4@g_l0|F!)-91O)quDkl8EW;t<imvHlX-{kH9o9YCCJLWa84^ArxSQuu?'
    'dp^#ly9g=0a02%l`<34CU*<rN1sBhoO7hl`%!%Z2`Da5c`hx7g{t*p8#>eKvw!@B(HC$)vt*;Mr$s4xKnqdx?GMl7bDo&(n?}UKk'
    'JmSt@{EQ>__Ptxuru}5Ekl*Y64epHp)7{sww{aT{{*{gTK1VVpDamo&_vkQJ$5s+u9Lpy;ZBvQIQX*xsrbr%_w5+Q7?}zyU24BmS'
    'o%HS9^R%(JiyZ(1U@+ffH&H08a-op6fNYD&7?aBUW4g2zWNe?|;YWg=&L+(;UFK+gjm0^ayXGjF9#svET#W*sIr8;rI^QnVOCvT_'
    '_Kb%=Pc+1KHA}_24d5v|2hC4eZ6m1OEDX!DLgj0&o=|e`ruV}3&J#AzbZT~)*S5Uu=w4~QW$Fgeubxk(dBskY-|VNXJ{;a^A&?Jc'
    'yODDK^*$VRF3q={!QEF+@AdbfjK|NtJ<hX54L9hCY=*~%=gp1E;(m5D*vU7!7TWV(95WW@6R2%@O|=OO=-KrAS+VT%pIyqKYoIMx'
    'p3m*0M(bID-eS!qY1JVqLK7>VFCl^ev}sK)J#)4LHp9c$-=FQYtTeco&C2xVeYD>jsOs;gA=Uzf56D9b{;av5afaT`^X?!tnz2u&'
    '(x9ePUeyP?!82^A;)O8a)1Hw5S^+VG+NUsT$a}Y*tgfe2?FmL<)mN<e)Ek}vMg<2`d!E0psz$&&#n&Nv-_g!#^`pGVp{%1n;@kA&'
    '6g8Inp|aa+i$Ok(7Am|`KGFUxJdYLs2*<4hKNH(LJ@m*Q=Ig$F6M3xYwY00p%@tz_1k@&$;@AJR{3Te8c_3zK?qpxId0E?f?b^IJ'
    '?Eo|F5Fhu^RmRLJUDZIx-;Hdwl+hCP=v2sSZ8(|8o)@H^(z_Y&B)|>;jW*u$3iQmJ-gXIuWj>xFTLgoita0$X>6Ovdw?4P3E@sp1'
    'F7^_arc|`U?Hqp)gG4DXE-rl6m~5~#uvaG-G^~at-GG-f$c>AkWRHiXnyw*83kwf_fY2yRk<pI*Ywx4--Rq_rE#WH|P&@ej&%1{5'
    'Tpilt&G)U$E>j(xdIJRK1+cCCc<{@K^(Da5`vFg=xf^G=H$DV~Bm*#HDT|$W(j!P@GjPMmR3%n4>qFKdgl_o3-P0%Lg8$IUj6Ck%'
    '4Zmu?m7`1a^0S-Bvb#w&^>)EKDPFk8c(Y_mPdrFwS5^hfs_%+k(-YsTluy-)r+=~1>EB4<^cyOhbcO1e8_McgRP_(+My$3~A(~&d'
    'i!D~!BQU#K>w>mSzIc8@No?nff-|Cpf*};dmV_6-LL}vAW0=Ynq+3U4SWtC1kBp&>4{?q+E=16kg54IB`Ak));^HOMVQ#-#6sIaF'
    '@Y{uPX2T6DBQ~|WKkw45Mrz4>>(p1pE;<-E1-SOwODJ@kehxD~^F=O*zfIH|vMz&_8X@d1RceZmeE&Zd>{$`8nF&3t6&_j{>}gj}'
    'u&W&L!VsFAM{%V~T#@s}D{}65=~=YAz#BQ<dIS1dGE$K>seqa&svsMOlL(!u6H}tY4J?_n{c6kQZywIWxU-|M7Y|rD`!&4w^EvUd'
    'iIysJ05rGd>}i_~L<L#7isjJWfpE?CLyw!-a)ckRCVwY>+ukYK`V1Fzzjpe+Dkb*=yos85<6!}A{D~ljnwCioSSPA*9cWc7dky?H'
    'zF@HtDG?Faw);`w(3m_oBeOuKP?%a3sJ6Cw;MK%BkMvqO_P{%Kn}RxF)<_SW44C?Bfb>0u96<3ELchDvm+4o4oAhb=Rp2_`CU!`9'
    'SO{O>dsLaIIq)`;II++PsYYxVZv;QI-sf5UM3$T|r!QN`NLSA|U32WelyytO;FQ=g>5~&M$F50!e&k5bN@iH5QDk9xRg<g-lz*dr'
    '(JwM%b_mW%2iCpVz@D-jpcAniiNsSDYMVe8jW4X%T*`&cdf0_tcMo^Nq^c1h?LdKHxeHX0T1sgKk8W)OO6wnVJ-S7E=m*~@E(-BE'
    'sO2M5U-P_y3F<z@g6CDAMT{Y~Y&~b0fSWAhMH<z%sU^f-VC+Q`5fqO$vvCNcA;4x3y`%W=UQSo#I;{HZ<qWIkADD^=-R6Jyxn6fw'
    '8i}OyS3p`*HcIF9m0?n{zF@3?*zOJHZh}@o8)MI}-`Gu1z>BZw>3+DAe`_DYoFAc2LB&(7qA5^LU+Go5mx{E^+2u~_6Wx)1sCQ39'
    '{bXAR@#v@$-K;oNbls=z-O&=rKr_;uY3`0ZC;i=DhgGR@oVI!)DlHB8F48SA5{+xd6H&DYJqS|@LD%|WevA4{YS+`rIPyVEnP&VO'
    'a9>er*f2>?#DJh$u3xE7mLp6XXlcaxVly9)oa=+L%cfR~7PVeD0;G{ogeFj|N`U7CIg<hF=mgUH*sQh-bk|KqC<O5Q+Gw%VklKkX'
    'Gz2c2Iu@uOlKh14rfR>1*^64bN}9fkJ>w)9eb4H44?+#U&v?X|sO44i(RYsI`s(=#nO!UH9T95PopHJh=L59%nU07HgYA~<@{7J#'
    ';8S$}NpU5w{?Amvv@)_yJ>zf#bjeu>m|4B8m6zGVXj7(}A*pU`g>Z9xevLwP&L@6xlaf&&gHzth6U#ppwjQ-*JTE9gi|6SprDT|m'
    'b-s}+o!8jce%k?UEBM-Kt6r@;sVz$8XVnqGn+S?GW2Gv!MWIw#0#7CXesbHTy8#S1%~aVah*LC6yc%Mux#+dohSL=u1h0^t^c;jp'
    'g7zKm;$8Vns!VapXP&<kwv^8CQxb`LHb0d<JhmIQJ*NTlUZaaT4oR#&0iG?BEa>W+a{7<S@ZEXV??qrpyFm=zy>cH&mBfqH?Q&g_'
    '0@ND{??N<GxJ_s`9wo5)6Ja_?KO`i_twlseoXRw?HnK;&XLKa%LR(kZ^bC)S*_h<N_~X_yer7qDKH3!$EpvuC(L4rub3?e|Y7IU_'
    '@R#@ynZXgE&wOC>_L9?`s|3E4VhdSmv-)X^9XEkl&y*`aM14)Ef7znR_2m_go^gxr^?MjTXpQ@Oi$Cn`+2~~|EmKa+_F0!*EF3qy'
    'GML+cT3rbK#nGP*j(=$rgg*YaZVC8Yz4sJfz&p`>>#F_0eusiEf@{tn8@z9{RSw2V6LLCpkA)}Mgko^CGlR9$?GpRgLoSFl5+6OZ'
    '!O@24cE=yX|F|#~uYtBP*n`@Uv)`dFz~<1_YZT4Lw~D$KN%M_AMLT-^)O;7MQPhVlPO1;`aT`iNhPUm#(2c5tp%P>7HV74LVx}Lh'
    'XD+SP8r`1aobvvM&igPmn4X_)Jv9eZO;#ReYqHL)vRzwedJYaC4IINum>48CwdWK0$tgtq+(B^`r)1YU*X`z<{js}P^>#=@Zk~b%'
    '9{3o)Xtbs7iX<Nf7XCvAQ&*T4KO8)NY4#A-j6-#hI1MMe7UMOSmz$3JixP;2`3odu^gZuq>b~qs#oms%j!UhV*>t}7IJ6GsgQf!7'
    's!=Zta*^njAg}OU=x(>1%r18?uDM)`kN#F_r?VRaJ5$gva|wi=52?MbKmGKg;w1A{Rupgj##O^z@25e}16xac_qV7dULWX|D&fks'
    '(ge4)*5{d=k!7)E^1w>7t?2Qmijm64LCC6g2yi|y*}68ne(l+0kxX00Z%euJXGNgT&ejdA)@c*lUEW}(*F<HxdWlFLS~oDG5wDp7'
    'Ayt8n=CIA)s2XXJJE<CVIwJ*HOZHk4Q4#lH)u6_&Qc{pHrZce8z(Q=*uEiZy3*A<~H5~XuP7x)$MVFV)Jww``jtWUV^Bb@PNiA6C'
    'lPeqJ_-`t%l&e&<8`LSv6(rjA%Ms-kgGQD5To1n0+E#VO`Y&Z_y~M?1JWP4@RJ?L3>@Q`}qeSJ@$F+*Eq=0Fe!SmpKv(esMsI3_l'
    'm!|oZ)-^ukw0U?fTtikRugpi_zKcx#L+hFJtuPpw=<S38bM?QOw`?Zx;H$^?4KK`CLV3s?)lRO^wsEXJ6EQSeP^=KRL==4{a+cRV'
    'kg}w)r14C9xoYs>1RXUCptb^aik`ogU4og_)PMA=wI6EMm4eb|)$t09Y(iuyN&;0K;Z8~l=g!+iM`pw-Uz<U|e(EJdqs~=iTQnTa'
    'fwK}Ik(!w<iqM0CKlm)Qf%L&XDiO(kh(h7FS0DT;%7ZNR*|rnx^3!G5VWT83+^$-9{CJyAA+m70ktF6B5ZQPq*<2U4vkNl_O#K*`'
    'Krli|RUPpXpU11v{}q*RUa=SPivJ?^iuX(r&dN^xxpQbF=l8qw$xXolw_4NE|Mbv+{x-c#%DKNEo~4Xuzxe4>nvhQ@$@H%;dbBlw'
    'FZr=jeSmD9wAf`zC}rXil&Ywm3Y73Gco5Icyk=b52MUmQcCe-t_Gohvk2bTTmJ|I~N$%FBnv@9hHu_LZu8f@9YE9*s0+vp*aToo*'
    '6Sbp}NED%KqHJ%W*Me@A@MO@RYzg4=gi~vl<q3t^A(C!$vBsg=fo{9HK^HxV1255?up)MaKg{7X^cSYqRftWLI0^lzf(k7OA1ZAS'
    'P0T`9<<?C{>-7i{c6b3H{k}p@&gg0fDr^3kCRVZ#s~fILEYBcY!xN{REXF_I-kcficrjlf*|iNlDTWnm;okoY4}<y+26A$&i$nT0'
    'fMQJKVQ@1li`f4_$29e~Ml|J>b=i2PW~<G_juj%U&&Wue^|1^6(8S43RkweX8)C@8`u=(n211T{_GPW;k=R8qc_)asp1Dj%OXo^Y'
    'rCUo-<;O{cKR2)?pR9LZdEF)*<bMTiYj7NOXH_{$D;tLn?}-vuY4kgXGo^6VZs5*a_p>~78RfQ~{Aa<dv$6eL-oC4^k3G3IL*HH9'
    '0uh>|qow{k{*Yd@Qy3SQUJu=vj3VF!EOl-@qtx`QYh^mo_t;YI@BuQhuWQ5}oT?FXklAQ_D}ixodRNOC3ytVvq%QPOQj~zsXR)T('
    'N{HKswx#m}vMero0kzfl6mFKtO7KD=UW@C^8WohCODF~+0n=6%xLhr+t*qyipcD$j`WDj_CxfB#HJ+}sZq5O6tC62ATMP{ssz?X*'
    'J}YcxHGUSlz5;f|XGbAiOLkrX$VxMLfp&5X=tdy8H?4`h5F2@6jpXe@;(+$|tijx`xEjzF!ajCxKBJ_P=M&EG#WymDSGL%y9q?*1'
    'uNdcedU=U2I{#-goj@DC<IH38<jcdKo_~KZJbeA;=eH*iEC{0r=J9yX8mxKG4Y`I6MT*<UD2~}*p)Z#$kcmZS`ysT`AXt6i0plJK'
    'q?-jJ1XUk}#jq~s<8^8#J)55Es4=sPyH4B6u~iVU%xFK``Hy|Gsn6z$*TQP0${j-&E;a2RhwW`;+PES7bNAxa(a$fxJ$U`%hvA!F'
    '-u`g(dic}x*N5L7oV-0b{o~*s!Epo?8n%u2xCB)f76BQ*oj?M-(dza)$XaK}`{nebC-SOZVZqDICAR2NPSn!o8qozu%kJgH)%C(0'
    '4oO4;9nKfv$Fa9~YW>>~`_kmb9MnmZ76WWz_S4y>ywa7U)rcVYIDY`oN05Zo?9|ET!u%_7c2alGriu^&q3t@wVp#4pqz~w0IG|9{'
    '792pzW|-hpj}uSuW1B$3pF^TLj2sZ(tM7mPY*tl#ilY6G-hoy7KIKK|-6?%_{L@vh6BfZhWs=vIq&{{<w2>6xHP`Zjl@m3!HS!F1'
    '(N0y*_S)<x?aKDz@C=#uHsMQGzog-%V3DP=&y_Yspy=BhhTNVl!=yz()=>?lkzym&_YX0WdwC}MezFQK8)|0fvT`Mxh&2A80a*{g'
    'r#<a26{h&2g^c-;R+1s1)`=I%zGxxJ{v8!m>*Y$Y1yoyVu~nhXm1$$0l%jx;L9YV^tcjeY?*PwZzf<1MFFJ<Em-OmOLyZ#7drQ#8'
    'LW}&NJsq@K_s$Rzw9!eLnFv_b<siNzEtrVi%NRC12G~z;p>kU!xJPwpqL+Fhc+|YGD2PRQIsw5;kP6eQ?Jsuzd(R^;<B-iI`jjx{'
    'm~m=c6u&EuH*>6xN6Hvrh+XzAxIt&rcUNoCR<a%hguPL*DS^mam2;IS07=2E>lr)%Rncm-0o7O&YJP35+r{v5HF6<AR1j`zcFmz{'
    'djQESo4VBOuF|a9W;!yDpyN4!KS#6f$>H~J4~~Co7w-4r>$m#n4?n-r!{8V6j~%Y+&uwYUEpS_Q!Q9Z|JjC+bP;MiC@_3y+wBct-'
    'DWOj6>K*>oeZG3P0l%d;_`E3_5i|yk;|Z3oLS=`Ii<e9a9gxLs+$CGUpFyIv^{9N$zVh85UfXoh9gW9OvJQJ~8n)Q76QC=^P>Hs9'
    '9E2)~3<NT{cG%?l>2TOoRRe(es_Ziq{0HEac3n;%_Xe$JhOgUP8(cK^7JGmAgZdggQRAQ#fFS;OZT#VxlIam2E1e+}mZSJ~R89`?'
    'PdHVE&%~sxfhQ(qVK#ev`T_EZSXqa+H+9!58jnzGix67f;SiX+;jj%nX&+`-uE*vb_?+WG+}EiQpabBF)L;YOA^Y84dP{?;F5J`@'
    '5+wU1+RPxi*4WOTvcODhyto(+TYh;HsbJVt=3K}Z0iUXTZkQ6x{3Kq@5X_Fvbc*aUU(X$TJ!1uR+FhZ0Y-TS)EFy8$ZZ{SW+|QO@'
    'zid4CTb<v`j$r#|3L|uTsnZmkpQ2xEIYFL?ls`&=`>&@HqJ8KTL-?DuL-@C+BJ!T3*>~;fUUpM@Bz%!nCaFWgKP;BpAvnJKql5m*'
    'hn&<N_KchDl|1D|c+A5DUbW7AE6$g-XRVL*kF0-4x7{DxPRbUlzwPtvo)xo6YLEV^oXEcc1LB`IX3YJotB5bEx|dXX?`jNu&i?iH'
    'ZgSs3@<so)@_5cY;y2BeCH>*eG#mo=IULH>L`!*szEKAsry$}2b82Aiw2K|haZhH3NOY_kWqG^PD|UYO#qOqD?VeBPyP)>vG6kk%'
    'RQaCZH^@-WCpQzyQG`CB<KjERsIkMg%_@P~<^Oqd^xE)og~7?x`N^Km@#S!MxmiQHykWuR9WdgV6wNqadI}h^KMaN)^KJDpL+REQ'
    'O|b(pqIg(38#UFO$_n?6nZn`AMp<yKrd_UiW*AQ+JAfY)r}Y*cI45MK{J-;Ja=l#N7OTyC4&npkMwnbJphyWge;71j{tymVQCOp)'
    'vUKsnNb|F)5s(1FqMV{91y9CT$urAaTBl?Kae_h+sJF_lo-3bKz&6N+pb-;X%Wvj}=;3N2b2EDlqk3JEaltGU=|Nos*s{Ymi<>qm'
    'S6ZGKi!10vMCVT+N-?>y`v$;+!eFUO6$IU=wWZAG=&YvvrdEv)<?!@*=dYvAKe#%I-Vceet9V4yxe@iIW3@-@7(??ucA7Ha@%oVs'
    'Pv=EaqZwGOH0_K2sb>}(f}=s%hm`SgRu=Bqk1qpc-8H7<s54q`uy8l|aSTUTP+<BFFD~?9XxtZHQ^th%liM<iqN-Ra|5y~))3T(('
    'fOLlyl$zfQ3s{q_n)H`9<Qvw7%yFw`;3H;7ZgWI99GXTgtqB?U;dN$Pl4iyLx?{gsRW9NJw$O~8(ck9Jd&-P2pV2@cfD1XDGZAOJ'
    'x@MOJl@Oq0On~%(odB2#u#$FokWOWt24VRT=arE9N-g!ko{m&QMlm(|^mT`fLULAMmSr&YhT6vsHfsl+fyT_@M>mhq6u0=gzt@X#'
    'Q!#wGsLa<g?l5>tpFH5(QUmk%+-#=z9A5=ygGu&3K7sV7p(h*Meh`!ek815caRi|Lzv%B-e8@ieqTg`tD0&;17khhq`yKq>+r7OW'
    '{_n4iharyVl3IUzW0~GB)J=wNNC9#|VwujhyBO1~0Ey1s&<3BlKPe5-XnYG^q}D3)xu-ao8Gdi)<LztUM|psKxk<Zl&rZvQ8H1tA'
    '@nP&z-lR#h@mDkIN4N%Fi7sYW-O!L%{dm!<7&0RSh6`gbL%v?RZB19d0pSxP9#wb!kLmn!A-5qe9>2Mrj8<PiHk-!oCwtnGgea~^'
    'HtJkH?|jFO%icD%*Y5*XMoklQ{3H&p-5Qc@&t<G(U5`H2t#9^w+lho+^zkO(J!?DdF{|zj;nq?^6|%;g>t)%r?ZF^cg2o?iT{2jf'
    'ByKELWxr`QNW0N%wAz$@dp?>|>JHaCTyqLAa9*DR?~A@2r)DhNIQM&lnw*>FY(0kAVlRl`)5vg4Jqag{qnAI*9`c5#z+aj@)cFSN'
    'zP*5Xf-Kju(b`wGIW}%?|1P})0{n>;j)3Dh+o8+yYzJ>sV67eB0@UhkhfmI#5w*+@9*_TvUn1Q)+fj9oQ0*A^>4=B!SF-Kg!7qT9'
    'BJB})6gq<`nRCE^_dxx*7YxX6JvF1}<qJ91E^IvD%KEd>_4#<@oDJ&F3UnXfGC0wy58fvLMDLYT8qENiLbvo>$&VyVZJmL=V&>oT'
    'L><usX&p`fS5poF_dSL<u7=|D8*NA#0`?7&Kn=TyHO5F#P$GteoD#B1BC+e$)NxlCQ-C56s8n>l_o}p)988uFsBL+_CM!3l^Hw{A'
    '9baNiM<Uv94R42kwd6uesSaV4&AV2+mL~9VsJ+p&kPH_!$YEYz=%dJz2}55}2!ZuE9e7G78W1QzUQVDMEuo@txX6GPFpQKOF|4H_'
    'I@=Ky(b>*}bwt`KyIno>hIMC{ER8=dR82O?k6(7p73owfVAU&edmG9zg?6LyV(CRyKS)>PPBlL`AC;4*PwY>_tU}e$v~Fopa&KH)'
    'RJsD)tZlS%u;ET{KdgU~udCv}#huGNm{P7dtUA#z8iY70H-YtVPG0<Q@YD0cub)Hhl%<2(zIguT<mXoh!{ei)w^)k<*reUA=gojC'
    '1dC_dzd1ho)4}WKuU{Mt-#mZ&!-@H(+3@@&#8%!R11!jmw!RQSuhrV@EL%^nZ`k_h-yghwdoqM)-#&c;z`lL{;>Uy6FYTjy8r|W`'
    'gJb$+J)KRd-}jT%d@`dHkrVpk9K56_tInpJz?a`1VwF?Z9~xnX<aE`R1b;)0LN9b&oB8D&n#_;Tp$TnlkqZ-a`qT5j48Q&5?E&=o'
    'r1-Mf-+L_o(7C*rjm$28K?_EFlcSG8N&+gTEIzxJn{qUh+hA${ZN?zmfX<jo^Z_d{o{rwl7v*|-Q7R=XU4iK5W()MS3q#%~GwITD'
    'vHUt>^t>U{r;1a%8Z}p=8=LBsND&{gF8LW@gYMPjBXR#t^|^CpB5w{Kj3(&#9(>(Af?k9ay+97P2wB|XQPBYBN>>@&jbSsN8fm<_'
    '98FhNP!y-WyL+c^GrhKLNFTNi<BCCZ#he)rw=v!<v9i{L^x&uuYeZf(pad%@A#0VR36ix0x>fmI^Ad7)LVofgj&XRkSiJAk9Mz=F'
    'Y7BWfQkd6;B^mK`s!Os@j#kX+T$t#i^KLU6t(vyJ-ex)`zxD!Ml@b;9j38G`IQPx^3Yk6AXinO6aHFQm6PPyj_8Q`p%V$)t5d>N@'
    '3-IIl?xp9pj*!@KJj~4jzadSf^EIL{@NU;;xx^+*2;YLTYuv7o%BN@tic(kTvU!WLyD-x-)V6_XwvL9!FOOco`la|M{d#$LeDLD!'
    '(eW=y)0gi6=f+~>w9ft@Oo4SZosCtO^kH?c^5FH+cSo;Y9sRitgCAaw`>xPgkjuM-TgL3oTmwCM9Fdxh9vx1Gd=C->l<~OVufKhD'
    '^y0_L@g>akQvD3PpWy;;UXD|lp5RsYWO#UTeDFO-sTy7nUFupYL>8W*Ch_ZjVQ&Ep9>A?mdEq%*MK(hl70sEBwIarWhZlyIGygz3'
    'cYuRe8tB{c944W`I5jw#4saXMbPRO(16@dni^FaZMsCa(R~vKI6u;`&Xy7Q}Kq`zF61?v>ySXBaaN~p~@_e?yT(64~Q}&s4GGxN='
    's!xCa`>&q1-KQysQNGs@L@(`4ac+RVk6+QeM1_O^67bz5JAG6wr5a)cQsqt?t&K=`zM<+|VDlJ`Cm)Er8BXU5{tGp4^yf8jjl+4#'
    'KQH8GGFRDb)-)0~^dZ$-3$&b=<(B81YzrSN^NSl-OZFV+Jub$Z73qLS(UvgRkD11KqtX5Q!mJZvGBq+l7+hp7dzu_0=?#xmZi7qy'
    'r_qfUY!D=`@<@}#eB3TczU10c{;_-&eu>G;;E*tP(Nniad~=d9RBAr+4cQ026vOsl8Mz8JHVSX%(}qjzz^HLUiW4N^0(e&~L!lT!'
    'x^OA8Ce-t8q5?(Eyp7}G+ZZE2k`27LD&_%UQo)dc19F2!SKwUwY*@+|=R-6D`#j2L<2i^|3_&?uS*8aW1@C3cXAuIB)r%;mGK*C%'
    'xvJ*f&^vIk2EQyW$F0~u=Kg&)6(U^F#5TI=jwi(Ida*BR<Kx-F{n8bq`TssUE5B_1kKW`Xh^Xerqt^duvKf6iaQ5`!;L8>??Kit$'
    'w*JFl7ofKygARi2ZL|I$Yb`uCe$sunT5OhOGh~$u-eMAN=XHn*ep>f$`UO=wBlPbL+~zbqlK;ja%LoS$eborfVP2oaUv1&}OONTN'
    'r7Mi&H+?q`b2L(WVg8ldzvljxs|#)#kX*T>>}Q<{EhK|X%)tc=IxyT@@rNy@MY9<Q)n7d}8@m~b*8J2Hu%GPZvlTW|0{7D=2qYnP'
    '<GWTUg+<315WHQ00k<wxRhucIylCYa@=-`339Woyf`^!vcmYy@6+arz3R75^R<~zo-OCyLce>b}k3LL0hFdC^lT~N7`Pe~)%PAby'
    '!Iys|%F;_oVqWh^d9EQK7z834O@j3&TZvu9El8x4&_*xXObcsrQk;xR&p}p4B@AbL0(A{nL^gkdB1)W@Rb)~F?+u_`WA#KdhRFJ?'
    'DH?JX#;QT`Vo*Pgho~Vb`9m(Xr@>H(R=EuxczkeLj*7_akj#+IPVE;-c4aY@IL4<IEnXHI^og)FywQ8eW(o50Pf43o`yR*g*n24{'
    '&qgH{s9i5E7PGiKH>-WIS)wYp4=k*t3&3m@U3CrSzLJ`$yv(guqJXn77jBN(@3B-E7V8k?!?1QiAr<jTa*Qq4Vpl*dz_xMQ^4`eF'
    '(hpDytk>i)7SfDx5bih?_WPjpI9MZHE0O4u0n(H*N}y;GJ@66ezd~VFzVc{z@ELiq7&4qryp|rn7ZLBbQ{<_;LMElz_@g<b`z;Q='
    'a9vYVaUck@Fd0EdfYN=cKE(%~XIV|PZc7t=wr9vXLdZRkBL9XY@b#%$-ODRMhB&L5nW*U2)nK*N#lOm_au4nIXn=#<DO0D*c7Z7&'
    'z~-v@3b4YnjTNbYCmFUv0V!w4?nDA62RPF_p7<km!wZ-+Cmzp=P?<<s3B-qiS;esyb26a3g`lB$W-wm>Qiu{>kStc+^QTXkgST^('
    '%Oeb>L8N$4(vuJNU-i^AJU#6s5H)F8_KHc{yWFj{yWR)sE7>*(&x3uz@*X6QnanY2>SnQeKUqa0AJ7X?<vT-@&e>;Sc3JN7h=Cic'
    'gc-~~Ae&<_(TfE(*di^*Me`Fh+YqX{(5>l1Ga~@<G_;j*dDL%@kN$jea6FW;b9Q+d)v3%oq>}_Qw6@g+DtH|vFi|)rE2IL#s=1}M'
    '%v)xq<$bu&@|@Qh6vgFoL{_}fc)XgFrJ}V^Si<02J%M1ul^N}DyCy)oI#s=BDI)nkvCGsEw4WsMVSdW!y&d^hkZi*N)y>444OZW7'
    '=kVqMD?e_7w+BDHIXZs+YWV!+%j1KSlZFu0=>3~RAmEL3vR_ZCae9MpXYi<Z$`1Je^fc};Ns!|HUqAop;N;Eo7YAI<eanjYL_IfI'
    'gHmNB3;+kK^Z@9Ls%q%|iVsq&%PJo_VOu26P!h`U5plbatB?k4bdGfcLNs##Q=2Z*@d1$P2`M=)Hy7PRw14!7D*6ewhjN%$3LR1<'
    'r^dY}E;`Lzf{DuXda62%Flk@aMP(N9Ls9Bcn{8OA1ezL|;vy>AYq7gJyPD*$Z1Mr1JJZ0Ek*Pa{?p)G8*eljLfHMGn=g4IXf)$|T'
    '3nTtIl5y{Mps0!Bk_*bi5`p$;k2~kyRCS^tQ56IUJ1|v8krQ(JjEjUCjir;m9hwzs+j06A+bF^3$Dn<t&wU&+gKft#xJHV%Yg^Rz'
    '?RD-Jo`xbKNRv58S#`L_`odOvmV8TcRgSHbqo0po9M~LN!|x7X9S{W;FFlrE>V1Cl!*jlf8&Q&KFoG^|_br8`^gOG~PFs{+v~JJ1'
    'l=!m6*9ZCcWruO_mxC8Szdby9JycM`sZ1{&m_+~KU9a2fvQrKF;&S>C7<iQ|MO?Zh$SYmu9uOfw2GteWRaR^;o$q6{XK(?0w^?k;'
    'su6@b6!pp~AhiWd6?xuc3)o(ZJcr%DgB*6=%L*yo^{sEDWCOn(6gN+>5Xp~S>O<B7BKfyq&@`Au7&!z*c(eASR5z#6#UO<!k>{Zl'
    '4oPvTv-3S<K|?VEC>m_osy5=k$Op~o5X>4nr9esZ2N7A4AqP50^xK=e8U?5h>^negu4z&$JVg@ADhCj);nI!_q74VvE9p!K@Iykd'
    'OFtqL&VHuEA3Ge4&P(z|3PpFJQ?STV`b1o1Su16P>+$09GV7|5FbgmJv=~WiuJjB%px>cT=#(;p_65I>EdpL|Dj_yulRxv=m3V!#'
    '`rqU`tD|jM?JzpFjLqNgR->_3w<-$ak!5lgbAy>ZTqKWn`f6uz$D6EN`5MUbvFpxRBlI|<neN7Fc&mWUI^HH5R#>F%e)8q2_-MX5'
    'cz$vK*UsCc7e}wQ8w%9^v<sQrnNAOhiUoI=Z4ynblawKcnT8YJ2iA?j1Faj5+$cMS;D`^qxkap<qsEBx#tNKT0DFH>wRCag7Mrw~'
    ')K{yifpb(xGvSg+mt*YRVLuBAgP9X}<&U>fh7?6`Kx<fB685FKMx_j%9W{`#5m^XuMg&3HI9?TwI4!R5sh&lYm{nIq6>b6hr#9kv'
    '{H#J#%nPT`<P~EwQk>+7@X1l+C!{hb>$m|WEmHLtq)X6Rs=?r=Ew7l?<$@L!N<7cd%`MbSTUW}LhsRC$z;~pSC+z3A$I)=gU(x>t'
    '+CcGj<*sOT&(_m4;u1+xz?ttB%{s<Ja0Bq`4#xK=_zZB}ay&cQb;`;KG`9X0<9ZMpDWY#I49gv@1SgkU(M-g(ObSpafyx{ELXt;X'
    'p$&~M@q3WBT^zGSa9FObhA1A2j8^*{ccw0-P(7WLF13<6l3^9FKOY_cXkgWZDcW>5zSG2Y2|O%GYX>h;N#O1WUQ+X+ihaNo$adX+'
    'MH(_q$<fJ-Cyv*FY?%ijnPU1&V)l0bv~K{7R-n#ZkBm@KOfd(tID+B~B-@PB)KKxien1}+LU(%0-rcu?;vODXE@r621{2t_pMb#I'
    'PM9E8SSvF{MM0wCX+U~7d#1dFqOqFSRN%{F>M^O@9$q&#R)EAbn_^VcDRoBcFMKOlgkcW<0MhjRVIsrAq*))@6$Hd1Gmw_60uTS1'
    '4eRnZR&cN0akPAc0+u*{*;vpdF1g8*$8dPwUcn_an_(Qv)nqoK^!|Ws%$P+2frN2U-4n<Kh4C4XEo8Fl2IVFEqMo++DUnSn5aA+s'
    '=xyeT;_7z}o=&FQirs<}*BI_`#f<vnX*qWtHxfj9IBv>m$-)tEFd4sKdg(Me4r-u<=U1%nPdb|Ay~4a_3B`C-B1Ww<k3Gv!U$7pM'
    'd;4&*TwGj57Dro+Q9F>OV?7aTEM|om+~Q$odrA73DHLuq23d29Z69GVvU$i@fiyVdK<Sr|9L<#Z+<DvsA$Q*P=<^WA;^oI4nAM&2'
    '<+HnrrycYq8weFoammhjqYZ-22@Gwn3=p;Z22K^axU^>`^-*Yt3Azn82DXY$*5bUJtN_!rt6`NRp9{Er*?bmldxV<b^i-b)V~HiU'
    '7r#iz>y$Lg)ie#xn_r|88*|^m6b6~1a223IYn=fGuON0Ga{|GCnvr88e`(oO-xWo*5a!cs0D?DF*(w~e3Pu+1f~3mDuIZ^;ok8Aj'
    'hNzmrC%E=I?O`B>(&@a2z*pNUo6<0O0Q^EIwg$>e5%X*z6rFVd=_M6CS<4qX_k}zY3D`aeax&xDw~3jXiNN*IJF^7H?KIF!J#?*c'
    'CxhCA`Ht3xm72gM=f<>)J*Jvb;T6uPZ|P>rg^Sx$X_v5$i|i7=Q;DK)L=C&w?~PR5WPace9xO<3GM!VdtN@-fRwtWRK_#L#WQpB_'
    '3M)&mp&CQ-6Aw-FJPkX8AM0n6>R$+VmvSg1zwy_J-{d;T48lrLQ4uIizY!G7@v9g;D^yV;8Vj-4yr8J-z#7`BI?-43&lCFR_w>(G'
    '0M^)2!~{8^Opo@S^SXSx>&^{#w5yH@J^BOv^Pgusjdq<8gam+VWU2LT(Gzbyy#rjMn+Sk+yxS33Z--=@#=t94yGw7&@I2IEY7J@t'
    'G9&EYHNYU;=oJmg<kExxV12WrpAO6mC%chgg^$7P&}iM)=%ieaq2Q9*wQmmJ9Ke7fkx%^GRcMluWID-NShAfYF3=vK4p93hF-CW-'
    'tCVu%!5kXCk?LPV-ffjdPZrZelc@bR0gN3niJpqPt(qXoPFSDH;sdCU%@l?605;NdO?4n6KU1rWupZpVFgwp=c5b1N7#nGr(8}0O'
    '0uDJ<I7|Ft#E&HwTu|-M7k}tFRgP%jAech`%K0wh?#0zx#+d>ixWV|q6ENf1r=U8Q8N>$fseVjMh>G+Bnvx_V*3AY%TEC<|?S<2n'
    'A0;S*JQqhS<P&{h{WKjiw^Ih+yD<Zp-6S>OB5-@fFYTq8>^P7E`*{Jet*8Xy$*xzwLe|U7HWKRk)$*Q`-}-5p&iPW2wARl`ah`o5'
    '%&HSvmT;z0o%eCO@NK63Y8!9LS1pZ?tOJ|aFA`2^*~p68eF*IcgSs*RR3udNNf0O1F8uhXM0-DYD$}J7WlF%P42sHtj4JQNV56X?'
    'bUD8G!$f4%Ak;Kvf<<FsIx<W&Kve&LWwE%_m(8*W(r%xdcT@I8a@FwOb5UCI+VEa^Mn*JD@+V?u3<Y-kmd%u&Pe^3341lF<mOSyi'
    '$<oV>Bh_0l_06A;bz+<s#|O{f%8!G;ym%F7@X_)G%G8jOWQ>3zt4ibMoQs66%?`fSi3#xm*ZlOoc=%OR_7k(6+|DnW(tt~fR%Al*'
    'R^}6OBH1p(6hJkzeP~0!m|G?DRcvhaD!zS2SsB<Fs;~=W5CsMqf0a#29?C9Hsj@JlS*6@Pn5KM4A2+#fl;5zTeoY1V+*cjza`ljp'
    'ZONO|NAWa-z%;TgP-y5_D^9*4`Hu)&yT<Jow?YG#*DRO<*QRZN<N*0s?W!Le&h_y1%Y$QU=>!wsB;AX7*YMkYYB$?z1NrAflEPlI'
    '2*vv(nF<yH5z!2lsIe2;bTSp<W>J53L4z)bX~S_fuyF08+-JUlFP%haud)l=HE|mLz+CBs=9JYks4=9SQ(ezx>Wefce0Xr%)R<WW'
    '-_^jz8S_s__HB2GJnK;~_9+yH8<720zmKrvqmYhNs?dOVMSxA2Vb#NnvdO2vi!qQ(5geqH%%=mEq`o>IX1h2#;XhQe<KoB3ZJ6t~'
    'trdAE_RlB}Fz*p^R!HQ~6;(#PYEyMeMgfS)_B6n?QUL#nPj@kr%$$?iEqh+L+#{E>$%NAKia8wKtW{X;r`Cybxqr75JgUqE{E!5|'
    'tId3Q8<wW};o$f{_}L+<J<XNxSW#wk&gP}zJ`Ar9_IdyV3SLz3p_T}N>_YB%w-i*9pmRNaM@7lZqMYr(lG)l%^<i<v>W(WLMZiue'
    'Jv}};+ZmWq`U$A(_Yl_@Blw)%Gk^=rJ<z#wPjKH=r^<b9)=4GHWocDnV5Lx2lo6Mi50@0TSDY^vGfs`$qcGpjH=2-d&6BH#tJCC4'
    '8e$nX%iU)?ZFw?UF4Zq3a;m4URJnSnYK<qFq8Z6Owk6HgGsrgN4MmHl>aoi6uAYVxrFs?1jCv%K)%0@8`Tt!XSKxO&Oiq;F`BS(*'
    'oBJN>ML*bozU~4x0DZtqg8%#zswnsh5H8u^$@=sxR7+ru1uCyCQ7$-$Fq1cQ?V8ygvE%Df!ajVhN$xER*Ekd>pfF<sf=rKe!MLG8'
    '^AlujQrUx{bt-)@(<wt4D3S1xnn3*p=d1(gDU(2{jk}W7Px5W>Dca^Kw;L6Su;;{2bVMoz^%@Q1&HZ-q*zd=E@5cebL2m|&@!wQ>'
    'r`S;un@lfLU7HJapBN&wv;J9x@FD(>+z&Bp4-|3>rthbha{l#dLKG})=aU`KW6xoZz)Q<;qvHquDS|$k@xa!FYu$<gM^W1G!HM&p'
    'WfKLQ?Qq?o!QEGn?_tMhfqGe{6IwAl3Hh?%FTHv}d{6XkKk*44R8HCz-%W+{Nm78x+BPI#3v+XM1{XTqfqBWR;1Z=TabqBIol9}2'
    'k^1xrB9%U9<#qO8#-K)235bTSQ=wS&BEtMsFWlTiwVZ%R()9OdNDy&<`UJKu^wsN>nzz!>6Pq+oWwYCL>y~Bg*65;@o`eJn09zVO'
    'CQMgWc^3?}BEse>^YbY1W8S5SQ{}TKa!*e5Evd4S;cu(Zrk@G6A;U4;w{s&%<IPS#vkxRiSTGBf95j5B-vthqj{px?M78R`i}B;Z'
    'OuViGHHBXfZn8lha=evJ{gofoAxKa5@W^B!v>w>K+Gr0x#h;#dGdTX~;k4?kk^Z1NnU71*)Eidlk7ql@BfC&OkDj9?gvecNygQyi'
    'E^{;Z+vtph6c~k(0hJC)&!5h#WlQh_7h|=atmb9m5s%<d^@{kO*NwFV;I(}eG)zbgmF+!oiCU`qz(HdrYhY9JdsxvtmQd<^CGr;y'
    '#xyec2+`p$H?~agJa0H!V55<gRRf8MioZ&64=Hky|0b-X!W)GPSm2%!2Z;pt8Ymd^34Vjz`r$F>uDray6>Q|C+U4Nr;iDipKVeOm'
    'P!8uK6^p0d+4gUr;8;kID#0y0`M&mOuxuXWypb1)Q#A0)09rA_ZSE8V{W@_rM4LI9O-JSSaXWeNG|(6fa`K>R0<{diF(?X1EiXtY'
    'K!@#kG^wOSfm=n7IVU4kqkR2YwToZ`NLG6&?>++c7ARFy1&byh4Ra0EKFb~p(`{R&6jfJ|8cRw2F{1sN&}F-z>h1|S0}6~5acy_='
    'k#@r|r{)g(zlRd7W>^bzsRjt<qUDe+Cajlkpy@*2Ty+u-kIZr4&jfPGFg$Fw-}Z(e<y)mTIY>5=pIu#o9OI2(yjrBVTW<A|x81zt'
    '0hEM*xN>uhCfE4fY|l`GDCf4%D`=tcMEQM*r7)Anw(V|5J9Iu=0#wIk*8rb7{B3t+ZD+~DN{tviQKMEw<!(l+Yv%A*i#4fKLg?O9'
    'jO4c=XGOmQN=(BAL+|ceGA(Q!u`|j2?RCH#-6wUhnY>oCrGi4L8HgB78K?m`D9&pn3NECVjI#<_S_>E`;w}0yMM!vGN7x4l+vzYb'
    'QoPEUYtA37|Fy?}c|g23gA_YhfWzzuSC2V2a=%Bc-)-?yt{2Ot)ZmqT6%eI)4u!(_T_rqW*u25ZLw!CA+fpj!!tTZL78+i#shLo)'
    '2MW0I;d|NY{5)v>AVr|Skp7+9K1*Io+ZXEw)9R?LFntNRRVg7SMSfoU`f5p)SEy_Dz-ld`R6ICC`==|Ch`hv3JgHWdZV|topuBZ8'
    'D$O=}x0xr$vlT@tO8__uXms(%6-{d(FI1Z0g(!)TK6mUXiv<rY9$9u;6;Rrh^GWK@0v7^H;VSpOB>$4RD}o`75?G6=XS4bMx3V}z'
    'LBK;>R!8OY+B8W1d>e5OsGHJ11OpWD(<j=#A|ftk?oA$Bd)3qHYd8`!WN-mrDXfE!_6M*CTX=(7OhGj_P>T)7-~SK3_~o8UUH9)e'
    '#NI;}J`C=d7-!f@w(oK?d_SF!-9?KmhOmt?^x%_{oA2ja5jQ=&KIf($lbxC+H7GFiY&coMX_oz_*FJmfiL`}UtE{w*4Qeq9fsCy`'
    '9Ie;pTn2o3lIcna+k^<7EI~rzh}GgebHAO%Xnad4L#*S6!%jvN2{6DgZ1>{XqC822$#-rf>2<L6&3!>dE3`;Nv3?_wDb+8Seky+r'
    'd`>$H5sEA?u9vfkk`Rf70XYl&vs6SYyA*Z7X=qw5s3ugPvBJ7i4BQ$FM44f8DV^>7mF~JndwadTJ&*XeFpAvJmup+}EV~C~sNeK+'
    '%8^d-bT6qcG?&|ivV3OrC3^4p-q0ZI8q|EgQ?zo1w(hV%!->_oxLQmvCS@PcNSWsdXJQ<0i+{<j6FS+{T@7E-yP2;*_0)gk@?)mI'
    '5MSnpd;tMl7=`takBFvqi0Ii5r{E`V&_CMDAbRr2e{O*y%+x2j4YM@j{6N_2%3zhegM$=i+P}o}MQO#Z$TTpmhRxWBV-7N?GmahT'
    'LgR4URUb+2*yb+`6Bl~ds5)>dA6K;*GlN$S(tgH1`>BM3h+}-jGfSs-6II|$yc;GT*W%!7KT|O=;IP-_cKWv7j(XWcJg00m%+PZ|'
    'ed2}Ys2BCVHXW`eGZY03C*0&o<N^^rESHd%#bMFTKk;p7QBVWm0G}|8L7M}GM9YimzK4tVVZ|Q07wmc3oEwhw%AO|)_6bAz+RlwO'
    '1yGMq@(Mh8@+4?QKE}b}348JmQl%TdCbGR$Pg=@LdD^jTx1|%I@Ie<`V6d4w+X-Jnzd`I18Ho7_zem4Cz)}U0cg{i5Z&u+f84M@u'
    'BAINrZFVX5(agrDg~W^uRNC2D(6rJ77Q<i1$bH|kd)oD|$$sq9`6sy_R=Bw+KGwP-+L}emJ`q6DT7RYQ57hj9+@jv2mKQ9be1ajk'
    'ZUTQq&i<D$A}+d)p7FxMlQTV7slbnUGVT?32m##;>bU>wu!Urxf(lP?F$+g#@|Uy44gY*DmB6D|h2Ir#Z1pGN2TF5`-XcLYJYi8z'
    '3@f@WpP3P%cl=^LyTx31=SCJCj||5jqM|M)9)bWD#gT}HINOnM2uoPloBOt0Pp%KD;vy2x_}e2Sjwc2?7gH>t2cC!IxbYJ!jah#I'
    'N)bcFi`k;2nvtMo6dBRxTEcXJb_GDvDv=4daTa!D=H<o2Fx&82(ngIo<0(E6#}@+*au`Ze!&|^oVcchDbY-BMPt34ZU`)f5PiByK'
    'hSmoAn<Ypbc#DysV4!_xR@=xEm>H|IQ#^cW=65y4#FrrVzyw+Jmdf&13$Sv_;LWmJt=G%4x4U~ey9Ku#BQ2D>tI6eL1!&lnKnDB8'
    'Zu$%Eh5zlKX`tMdh53wF6Mk@cF<;MuP!j&JC?6J80%P-oO89TdghiYAyW@kCABNil4Dc`w(}4vL#o_td`_TwyzsI2jbS$F>Y2W?i'
    '!&ETBcv>#ahPPto{n`BZ;Kjk=o45Z3Q%r{;R7`U*OI^5z2bkO>pR4w4r1D-RRX{1A;m7bQ_wjv=2pDrhN^{wMS`3W4Tbc|<=?Tnf'
    'H-r=mVc^DZyGU^A+^jGq{|UO4v2spbC1`M9zIp5k6O=C%*oAU*$;$BZYPu{~SsIzys4|aEB@jzKUaA0V6S49A1~)FSo!tE8gX4qm'
    ';|~J&tGVUB)o`bC(t1QH7rt&4G9y0}hwW4{0m4us%w94EB-H>`!=`73q4$8f%W=!ijwaRNv`1=A21SdNFWmAXEFi4dObYT5JpKLf'
    '_h0=XVT=MLJj(fyVi8+CMgK>n2>&p5P-Rb2f(x|d+tLGEjupa5_z3Y09OWrG+?f9ibX-l@3tk2_aA$B8qVt<uNS8&ai&;OQjqeYK'
    'u5;FHsBKj&&=T0tHJ(btMfH=0JdAv?pVQ$1#+_|lG;p$E&p?mqVKaz6aWj>owd^ew`cIV(i5~afL<YZyhL+RyW;vS>vgqw#5FnTz'
    'TZ#a&yS?~*TxwWnqQV|yyeJ$<P_Vg;#7W4NI5hzOZf*dxV+b1olHtodGQzatkgZ}kc4;jAou#OsJIID#cOrki<7~5L)H>fbi^k=+'
    '^|14CJ$gTR;B0KN4>c)&IM}KpO=JRv4AhsxzB3FH=C-GBYp;j0%wpLRThh(=H<yd6L+>xkbXVVG)wAa^QC+SOhXy#g^UB+6bIRX0'
    'gIMv!3U4n(L_8&>8&+CSW(fU4Y}{Z7G}|7l08|JPi3khW<gzo{UW!$lz4iJ%$W%*7*?P9qwSYSmmbB`}i|Fr(MDCiiog1_d8UY)s'
    '4Mmfshn&GCP(rKsQ5qZXL`Wk)mCY73o3C-vEH=>b`6}*XGxyt7t5EQwB%4tl^47x<A8l2okhh>4P_NFIz1wmq+cJG2<{W2179$lC'
    'cyWT)b^i__+@nKmf~<2{I4Sy&@R%jBfc3mh>5jx+IngK&51~4YeX?947koCyvC<tSjH{l?z&qUn*gM+(tJLB5TSzE9`fDcIxzTzr'
    'aiVC)<&In`VP~nW4!A@Rt<Xj>oudwh)iS<w3b3}OPiB$48Ne%Nazc$mUt!v`Ay7Hr!-@4ea?!k`ws{;n7pS%gS&-6yxxNx#Q5*}}'
    'BFtaeRycTbuDC6jcJW!@<q@ITRlpv0F#JM8wGt|M#^iz$3__<RIVsChSaj$7BGrEJwhB$eUprc%XyM|8aUVY%<<Yk?dHevLpSov*'
    'E#FowTGSSV6mmK-MB@(jw6pSSwQy%W8Lhy%t0QJ}KN8Vf1w)P2lhrlQQa*jyZ@3CTwQQzYgD%4javYU}dUw>b^IMyp0}-R|e7BsO'
    'JJwrOCZfFDxQZ@*0rea{6~u-@@Su4}rrY!x#})9XG+9i_K=F<V&x6vVCXNR7nLh<Wjj&l|988Yd(E+5{WQm<qS=yt3i<CMryn5zu'
    '8heyPAo?O)_~6ro0>bQKY>WHd>Hhp}k1Zls;Ip0mkYGx~#L*q7lbCv)24v6d_H!(sxL`wWPY=?KMeE2D!p9v%S#D}tvxi?%>ttI$'
    'KB{jWwYQLUy`TJn`au=mCaap?FbdSFH4s10P|lIv49btKVkB{yP0CfE@z^6Iw$tj+Ugd1={qBT8bY~(UeCC;)(X?&^vy$O>1~~#v'
    'W)`9p)KNZy0BI*3M<>~eh%&smvZPliCbms-wy4&K)DxCIQu#$U@z9o3%9du8D^_5%av>nkKFtV+Je$*j$6kgEqt3<299i-}c!RMY'
    '#UpaB9x^QZl{dEY+u>q1*4T~lsq{T6tGW?346!_Ay&I-m(RD4U+O8U^xxqon(27eoBLnS65O_jsC>Q;%I8^p9^W8g;q%TIR)pP=<'
    '&e_l;_1W~@e6hlWX@sqAV0aJJxZ1mCI^Rq*YRPivrS$Q111aOWr<7|wAoiBK3lm82V?3JLd=vN=XeDDpy%5LQqIfeKqi}<bP9vMk'
    'Ko<?T@mdB}n8CJrx-WxdKXHUH1WBemrw9P)1N(fc;8)yM7rV~6FXio937-_--W4~{_OFDeRBR7>uxrgWds&66Ng{|_?K-pMwL-nK'
    'SE2!sxd9WsnQilVy%_*odV@V}E_u^1erG8V?x3@sJJa|c3(|(pdIE{n*hD(xCU7jci6)n+*(J^xn;Hi!KY@d=p>9Kfv|6ygE&o87'
    'X&cz2nQ|ZrRI9#@?Vl1}PrlD7^!Q(A`nD%E?_y6|n@x-ClHn+rrSCZ!MoV*Q{y%UODp?^3QwGBpY<agYUyIo*l`bp3_o%VqND}L<'
    'O=|R!#7`RvaeY30w^?k;c!tOZS%Js~RS<;ka$z0R7b_!7qwFI?Bfk&+#BS4G+RDeDw~DVZ@`h)EO6uE-+4N%D$owmj(N5ne8qB?P'
    '4M{ZH+1_4ZL`OlIp8SQ<ig9WuV2~QjU_33&{XHkyaLYV+c^R6v;Fr)lQtK+6=4VOw%61{5udhZ>nufMW2Ewy*<OIwH{J>L;G_%nD'
    '4#)S=2A3&<QCCWHCDo-ONL!e4qCE!_reaEHSg%I&@)Bwd5@GAOaA7}_1XDPx9_ozF%Sqt0soPn_5|vSoAWFw(c{}SxXSrC+qQ399'
    'rbS7~dMNV(HcvbIgT$^)kTuAsJYB=Sw0bSOaygm?`5N51c=jv(JR=fRJDOXyvW1flCB2j2bS0pYM9SN-9VYcjAuOG7Ok2fbtk_*x'
    '<wP6rVXZO`=N6+Qr=g8>n|KX+s!hGsF3^_^T<?qoV6MeNFL*f_%_ift0yC|SqLH^e{0rg(eBX!q3;6O>KFVolY_m`;lN0yjRmsZx'
    ';&o{5Ck$4_bFw!`$Q7+Y@u)cU3SVHor_?=w+`LqOB1(?m4YDhnI=5if;^BE{$Tae>0X0gERB7+o%=Ae=J~emAM{rmmKwbRZOzMsN'
    'J0|mGa->`A2n6YyegHd;zU8ifo!K}44~Ft}6iS*Q{C%6EH_C!F?_4j;0Rc}ewUv}#YoypuQe8m`kX=@EuoFR6W84m`rgSg5i?Qjs'
    'VCWKkXFIC+`P+k&x0oi=(t=3wyZ!US?~k9qJv@3nd~y8z<Od6h2?NhRa{fEs%ppjT-2Z?Eaj|9VA&mU-<r?z6D}EX9;UT!CspJDt'
    'tH@}GOr}#U%{{RnHpbiZT%6)-DU?=&eabm1{#In0&_>zykyKY%oVK%TRKtNbA4l<N#w|~(s?HOVV@HD#gdt*BfkXMcqf=RwSIEB?'
    'xzb3Q#dCvi<!w&r060%`33~RzDrhV`m|yVu1R3`(t-VB!2UiffF4T{NNh#|p(;0|QUnZRay~f@5RbV~!Q-4u)beH=}E;t4dB<vBz'
    '9xb=^pOe6a5DS!j097+>*4&Bf;BS!BA(_izTM7qnf=)R0<2Issai~Q<pYx%{;2BD&hpMlGVgMC(9~tNu{p2RkHm2|=Ni4;DP;lAI'
    '#$g_}?OnK!Z2qPPtDFE%CX)gH^VDP9=V_*WLM6q@v~X&Sn_N3T8&yJA<u}i#f$->*-kO^^R=Aw=(F;`zF;_48kvq@JxR=yd=k?Te'
    '^wU|rbXp%>sfVuAKX21Jx4e|3jDqfF35gHXyzWA%))LSw_M<KXks*CsL|+BcLr*qP6?oo6J>IdR|4e?8+(ErmuG5rGwFi5#s*9{5'
    'wU^tW_x|>)Z3Yeei{Zn(1ylE({5-7uCmf_w!&<1jsCcK<Y}mDG3`7sFCg)d|V(VB?UMiK^Q-ScKyZyuZ?;!-R2mG%r1_&Wa3j#{f'
    '>G6c^qAouhWb^bmdn8({0wof~Kg0nvV)Or1*857+J-hDRC24PuX4O_yx5txf3&HKd1XZwv+w+)*6$Y0uj8|Fg{Vb=>!0x<It1PY$'
    '_0$Tfk+^M1jD~jKO6x7jE2RIajwtKZbg3Q2KUG8iKrMM5hZx|4-_b6sQvK#Qu}YP&JFu1v_?Z2d<^&pDFi&H%0%6iE7VL>RB;w)c'
    '1!`?cm80~zwUhMVI(6XGJm@QAe3G?LbDyxo+m=>gYTayZAz|J-RzS5$h0qnb#;hNdGRgBC&o01bPL8jiQ{t3%2VGjS^1Wo12Wn0S'
    'jWVbZ?WDVgi6%8#F1Hq%ROh|u2cZYy?PWV=SN=pNe9(sVFP)fIu&H4*PUK`HyaY^7x?6j7)o7~kGesGC+puN^oa|Bs-3_ZQOm{Wu'
    '*3s=WTU@*^B_om_s$jjku#Lt`z&+yo_{KB4B$0^bR5K!jOr_M&!BgUXic_jUj4mLUa{=oXPv-$j<eDBNZ#no-Ze>Vm>V{j}2&Xk8'
    'q8)p9O|QCFxqqFzJLe}MYSp=FyvWE@O<mXmyUr}Qt)O~PM7^?apA>ys+%&tExOu~flNod|<3#ro-eV*j{eE@y;>Y2^U(E2;@7LcZ'
    'z8C(dD!*4?l=FhXR=*bKl)+|>oU1#&mmZq0-uL8$L?4+d!w(WZvYcHy)-D}RTU~iLnZielTgl49nT$QtIV79Y>3Y2CL6o|uTf9am'
    ')rn!SiYew09cgH^qN@Vxy-m(X7w;ig(#33ph01QOCO~aO8B85cuFofiP8#TFmK@E>I0;a|fTmShc8RAtG0-zF{y*VuL95|q4ob@g'
    'l|_^voHmHdJ$J+yTPs)4i^Xg<1(lQGNXseE-!&AR?gW|ek-)=2p21V8F%6@Bd$XY8^Sv{aB@?44-Wc(SC;bM{k6C}XVR1fPfwQzU'
    '&qL{SD0aXITL-V-9=`p>JSnH|Kny!M{9bo*OcjT*8#@DYYqTjn6hzZP{+sD+Rv4;j_J;)toGDCkg&@y1kN5VU2-NchI(1`azx9>5'
    'S|D-K%ub|Dal_`mxq_W}K3U&P%;xmQ0HYFcm>Izgq4~H~oSR)cg4+%~xfj=l|D1xJr#P8RiogAhW;vW*4$BeBPz3I8e=EfDUlb(P'
    'l)C`31No3ZSm_#B5mxTz>XwFV{x>S-BXeeN%yGGy&c}-z%Vdo#u+e&PJ-sN*?Z)|$iZ@3mhkvo-HQcn>E+rV<0Pk)3+%BnH<hYoy'
    'QHu-QA;n&?FvoY_A!LJ9r9m0hE*=*f$mY^6zVa%n;1ypq8Lww^LdFD~+@7e0?3)3Ylu^=g?S69hr3;WaN-x0@|7p0uHIN*aKZ*9?'
    'sN}!krrpdYetxBVb|!<RzZ||D9{p%8%02$^^Xng9AN~3D(C&70J)l=7&%cKvz>oR2G#UPMc=FTpw=aGu(AI|U%szho{MGQg=ZCKj'
    'UYh4moB(YY+|5V3o0>~dN=Z!_vln~T*K;j}#xKuyc43is?@Z(ST}&ah)54T0Llizx-DsA{2zHzGW#>O#ZezHBh8UAfj-2c6%G_Av'
    'CbUrHW_7!-i@mDsKiUe2qbhhjXPyt#WIQy3<)q5c;<QKobN7bOwgxs{9gM<5)Eo{$CBb7o)x&yZc4}`xF+##%{EkMj`?cxn8^jC2'
    'Djq+UEN5~!(22F6lJRqx@5Oub3;0DtPc9&Fong0?o9&QZ()gnRp6>s589aPA#F^q+$x@lExBGswnonlCD|6Bp*Sp*>yK<xQVmgJl'
    '9uH+5@ED<A7-@Nm!Kr$fU-#jVugHs-`l((+VZmtyEd{X-MM2=y*$(d7-W>zK@7<~H@1+1cRd+Xx$i=rOFAwLJizXfB?#X(!xq!p('
    '*LZ(9S{Y*4C~*M8^U`4Aa#7%c{TdL6kKtMO>Kj$*9RLh@O~A)X>FLjQmgm#q<!tm0qwBf*i{ZvB<5!QhKAxM3pGKXwA0N_qNuF{w'
    '8rE*PsoU^f-G-~$AXl|vmLE3to7RH5y4(!+>p_IW>9xGL8m)>ii~XmG#^Ti&HcmpG18-S(?Q0`z`S->7#rCF?q2Xsg)M{71@A>q?'
    'pMJ#|fusJxhz=3tr%x(A*i?VPwb+KQ4!?bKeDtCx?Owcm^~%V&uStX@^Ss=iLvxD*Ss)d(`oJSBuNIKh67xG;FQ)$h2Kt=tss-K('
    ';~A(B41ZK&I?UzBkizo`xL39%cn>*F9w>Zb_?(OP9RpLiU&HyWF{_)IB<00q0);g+W{Y$4N~UIMxjYcR14X4}h<!aPxKBWiFfVtx'
    'L3ey>{_?a2@&@UpAty*OjYx}dd<uzNfm-nP!(Y)N=H7l-OwCPI5A0ye6b!cuA3BsE0QZr_W?#Pdt}Tas**#;taJDjEGKjUkldKn&'
    'TP3#><xb+3`u+>D1q>mRotqB)T3j~aJ5h+6Thj2c+$@C@B}6YldmW9nUF_KtcYeE?F#NVZhzk3&9>W*?)Mu<B!ZqT%jv15mdqqHy'
    'RjF<TR0Dj5_lJ9Xd+`69J=)`FG>*){-f+kqCm5d8;c;kp^zKsQzE3=cf%f*EjxGO#xj4wrV>^S7`UEh3uvF8fCyMctCZLsg1^kz%'
    '6ytHn;zSw%@meVei9^xSnh%BMOVnX*mLNnyR$v}_uehVG?pY47aZHf8b4UcU3D>Q&x`RUEpJ5782+5wBZTt>+d^OVf=K35BjKGaU'
    't5}`GO$?Mh*kk<jYhN<#z6J#YD&U>h*M%YKv`6}!$%RMa1&5mt!BYaiy~Lk)(CA($zGQ5CH!(~iRE5#~wp}M}?AfhR=+fB^Mtp+5'
    '%0#5SO~CJOWdFWYHZ}8~51f_Jx;Rtnt0_An@`C8U2mT@vG3coV_J+nyO+&XUooXZg#iN-T42Kd59i{k#eH~lKkpSr52{X|M5fdYs'
    'e?FXI+d*hJq$ZT6N3>dGJ{FBu9Q9AVK8nJ_Vc{gUAvL04sp6<tJtRDzZbS(%tb)r-uR_tS79{tzRAj)h_<KH)1|d12MCWdmB>+>p'
    '(9vZIyCTtBeIu}MR@FFKO$;wLnxpQ|Q1KDuMD5x1@t~9D%<A+3>Z}N$C<4HQs5DoLG58WeY6JPef>2P+$Ec*9-3mB>wVA)$j6ftu'
    'r5EY=t|qf3=+n`<S*#b3ARTH8bnQuped5s4f*W%mF2E*Fm{~%6(bNkkFJcnlmLbTmX;m+-!_&QipFGpi^(w&p0C^1>Xj|{9z%e96'
    'V*)>su^9XvRnl29u|>=s^Dvwujv;1-C4Gz?WP=jmJ#sJuy`QB;mqlVJ6p+|1X!lq@$qeWWkX7cNLpU6fooD;FeUppy+)7XT=tr5T'
    '%u;UJ;PO^TXhoRetGCXgx%CLyo-CX4yW-EI)wPn_cCp9|N(QCrVQDM>pqv(nWk#->EpED13#K{wU}<<|9<%^LDb6;Je{Yyq{O@-0'
    '(QE$y)qfcsZ?7gLEYWI03DmK;Zi$o~tUu>q^q9<Ui_!S+qYLw@7aMVaUJE#D6fxg}eG=lU;a^~S4O(X<#sbV8<Ii@Y;&At<4M8vq'
    'c1C4*i%Sepfo%^i=A|Jgn{%r@UXE@cY-d%JhR)B56_hzCKu@bJPS;&C$<aEvc-Zb!uEp?UW^!?b*>~l_83A>=9PdhZl#;d$oX^FT'
    'fSYq!j`L9o^H>$Ygd-TT5*aGED2>bqh?cIv6NAl8Xe|<0s8}Dfr42{<=I|x(sBE7*$7&(B7Z8c2CJ5_yv%sX}V%!Zpv}%#QPau2S'
    'Ngi-y(z}&fGY}%nO(tbF?lHV#JWA(JBPJ2LE6)(*-KdKGe!3MJY~6T+f;Ia7{{jSnH5d'
)



class Preparation(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.m = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))

    def test_target_scope_excludes_protected_and_app_writes(self):
        allowed = self.m['allowed_call']
        for method, path in [('POST', '/machines/owned'), ('POST', '/machines/owned/exec'),
                             ('POST', '/machines/owned/lease'), ('DELETE', '/machines/owned/lease'),
                             ('POST', '/volumes/vol_owned/snapshots')]:
            self.assertTrue(allowed(method, path, 'owned', 'vol_owned'))
        for method, path in [('POST', '/secrets'), ('POST', '/machines'),
                             ('POST', '/machines/683e47df5094d8/stop'),
                             ('POST', '/machines/811d632f2650e8'),
                             ('DELETE', '/volumes/vol_owned'),
                             ('POST', '/machines/owned/metadata/x'),
                             ('POST', '/machines/owned/exec?escape=1')]:
            self.assertFalse(allowed(method, path, 'owned', 'vol_owned'))

    def test_snapshot_ack_strict_supported_shapes(self):
        decode=self.m['snapshot_ack_id'];nested={'Msg':{'backup':{'graph_id':'vs_expected','id':'45721','state':'prepare'}}}
        self.assertEqual(decode(nested),'vs_expected');self.assertEqual(decode({'id':'vs_expected'}),'vs_expected')
        for wrong in ({},{'graph_id':'vs_expected'},{'id':False},{'id':1},{'id':'45721'},{'Msg':None},
                      {'Msg':{'backup':{'graph_id':False}}},{'id':'vs_other',**nested},{'id':'vs_expected','graph_id':'vs_other'}):
            with self.assertRaises(ValueError,msg=repr(wrong)):decode(wrong)

    def test_guest_observation_must_match_installed_dependencies(self):
        request = dict(nonce='a'*32, source_ref='b'*40, node_fingerprint='c'*64,
                       python_fingerprint='d'*64, guest_env_sha256={'AGENTS_ENV_B64':'e'*64,
                       'BACKEND_ENV_B64':'f'*64}, native={'machine_id':'0123456789abcd',
                       'volume_id':'vol_owned'})
        observed = dict(schema='cloudbench-source-guest-v1', nonce=request['nonce'],
                        source_ref=request['source_ref'], machine_id=request['native']['machine_id'],
                        node_fingerprint='c'*64, python_fingerprint='d'*64,
                        installed_node='c'*64, installed_python='d'*64,
                        image_node_fingerprint='c'*64, image_python_fingerprint='d'*64,
                        guest_env_sha256=request['guest_env_sha256'], mount='/data',
                        guest_exit=0, started_epoch=10, finished_epoch=11,
                        job={'pid':42,'birth':'123','boot':'a'*36})
        self.m['verify_guest'](request, observed)
        for key in ('nonce', 'source_ref', 'machine_id', 'installed_node', 'installed_python', 'mount'):
            wrong = copy.deepcopy(observed); wrong[key] = 'wrong'
            with self.assertRaises(ValueError, msg=key):
                self.m['verify_guest'](request, wrong)
        wrong = copy.deepcopy(observed); wrong['guest_env_sha256']['AGENTS_ENV_B64']='0'*64
        with self.assertRaises(ValueError): self.m['verify_guest'](request, wrong)

    def test_native_scope_journal_refuses_foreign_even_if_final_state_matches(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory)
            row=dict(method='POST',path='/machines/683e47df5094d8/stop',status=200)
            (root/'0001.json').write_text(json.dumps(row))
            with self.assertRaises(ValueError):
                self.m['verify_scope']([row], 'owned', 'vol_owned')

    def test_guest_environment_observation_uses_pinned_semantics_without_secret_values(self):
        namespace={};exec(self.m['SAFE_ENV_OBSERVER'],namespace)
        raw=b'export BROWSER_PROVIDER="steel"\nTEMPORAL_NAMESPACE="private-namespace"\nAPI_KEY=private-value\n'
        encoded=self.m['base64'].b64encode(raw).decode()
        blobs={key:' \n'+encoded[:12]+'\t'+encoded[12:]+'\r\n' for key in ('AGENTS_ENV_B64','BACKEND_ENV_B64')}
        with tempfile.TemporaryDirectory() as directory,patch.dict(os.environ,{
                'CLOUDBENCH_BROWSER_PROVIDER':'steel','CLOUDBENCH_WORKER_BROWSER_PROVIDER':'steel'}):
            value=namespace['observe_guest_environment'](blobs,directory,HERE/'lib/cloudbench-env.sh')
            self.assertTrue(value['provider_contract_verified'])
            for item in value['blobs'].values():
                self.assertTrue(item['decoded_valid']);self.assertEqual(item['decoded_sha256'],self.m['sha'](raw))
                self.assertEqual(item['provider']['value'],'steel')
                self.assertEqual(item['namespace_sha256'],self.m['sha'](b'private-namespace'))
            text=json.dumps(value);self.assertNotIn('private-value',text);self.assertNotIn('private-namespace',text)
        with tempfile.TemporaryDirectory() as directory:
            invalid=namespace['observe_guest_environment']({'AGENTS_ENV_B64':'%%%','BACKEND_ENV_B64':'%%%'},directory,HERE/'lib/cloudbench-env.sh')
            self.assertFalse(invalid['provider_contract_verified'])
            self.assertTrue(all(not item['decoded_valid'] for item in invalid['blobs'].values()))


class NativeLifecycle(unittest.TestCase):
    def setUp(self):
        self.m = runpy.run_path(str(HERE / 'cloudbench-prepare-source.py'))
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.owner = getattr(self,'fixture_owner','a'*32); self.mid = '0123456789abcd'; self.vid = 'vol_owned'
        self.image = 'registry.fly.io/navi-whisper-lux-bench@sha256:'+'e'*64
        self.shared = dict(id='683e47df5094d8', name='cloudbench-warm',
                           config={'mounts':[{'volume':'vol_vwnym366kn7k8mmv','path':'/data'}]})
        self.config = dict(image=self.image, env={'SOURCE_ENV':'same'},
                           guest={'cpu_kind':'shared','cpus':1,'memory_mb':2048},
                           mounts=[{'volume':self.vid,'path':'/data'}], restart={'policy':'no'},
                           init={'cmd':['sleep','infinity']}, auto_destroy=False,
                           metadata={'cloudbench_source_owner':self.owner})
        self.machine = dict(id=self.mid, name='cloudbench-source-'+self.owner, state='stopped',
                            region='iad', instance_id='OLD1', config=copy.deepcopy(self.config),
                            image_ref={'digest':'sha256:'+'e'*64})
        self.volume = dict(id=self.vid,region='iad',state='created',size_gb=40,attached_machine_id=self.mid)
        now=int(time.time())
        self.snapshots=[dict(id='vs_old',status='created',size=100,digest='1'*64,
                            created_at=datetime.fromtimestamp(now,timezone.utc).isoformat())]
        self.manifest=dict(version=1,app='navi-whisper-lux-bench',owner_token=self.owner,
                           machine_id=self.mid,instance_id='OLD1',machine_name=self.machine['name'],
                           volume_id=self.vid,region='iad',image_digest='sha256:'+'e'*64,
                           snapshot_id='vs_old',node_fingerprint='b'*64,python_fingerprint='c'*64,
                           verified_at=now,shared_machine_id=self.shared['id'],shared_volume_id='vol_vwnym366kn7k8mmv')
        self.write('predecessor.json', self.manifest)
        ref=subprocess.check_output(['git','-C',str(HERE.parent),'rev-parse','HEAD'],text=True).strip()
        self.write('build.json',dict(schema='cloudbench-image-build-v1',image_ref=self.image,source_sha=ref,
                                     source_dirty=False))
        self.request=dict(schema=self.m['REQUEST'],nonce='d'*32,source_root=str(HERE.parent),source_ref=ref,
                          image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64,
                          predecessor=self.desc('predecessor.json'),build=self.desc('build.json'),
                          native=dict(machine_id=self.mid,volume_id=self.vid,instance_id='OLD1',
                                      config_sha256=self.m['sha'](self.m['canonical'](self.config)),
                                      env_sha256=self.m['sha'](self.m['canonical'](self.config['env']))),
                          guest_env_sha256={'AGENTS_ENV_B64':'f'*64,'BACKEND_ENV_B64':'0'*64},
                          protected_resources={'683e47df5094d8':'vol_vwnym366kn7k8mmv','811d632f2650e8':'vol_r1jde9donnx2mn9r'},
                          scripts={member:self.m['sha'](self.m['source_bytes'](HERE.parent,ref,member))
                                   for member in ('cloudbench-fetch-ref.sh','lib/cloudbench-env.sh','cloudbench-sync-deps.sh')})
        # Original creator authority fixture: independent from any source-manifest claim.
        creator=runpy.run_path(str(HERE/'cloudbench-prepare-source-create.py'))
        journal=self.root/'create';journal.mkdir(mode=0o700)
        donor=dict(machine_id=self.shared['id'],volume_id='vol_vwnym366kn7k8mmv',region='iad',image=self.image,
                   env=self.config['env'],size_gb=40,snapshot=self.snapshots[0],
                   dependency_proof=dict(node_fingerprint='b'*64,python_fingerprint='c'*64,verified_at=now))
        binding=dict(app='navi-whisper-lux-bench',owner_token=self.owner,donor_machine_id=donor['machine_id'],
                     donor_volume_id=donor['volume_id'],snapshot_id='vs_old',parked_memory=2048)
        volume_request=dict(name='cbs_'+self.owner[:26],region='iad',size_gb=40,snapshot_id='vs_old',
                            compute=dict(cpu_kind='shared',cpus=1,memory_mb=2048),compute_image=self.image)
        intent=dict(version=1,binding=binding,nonce='6'*32,donor=donor,volume_request=volume_request)
        self.config=creator['machine_config'](intent,self.vid)
        self.machine['config']=copy.deepcopy(self.config)
        machine_request=dict(name=self.machine['name'],region='iad',config=self.config,skip_launch=True)
        creator['save'](journal/'intent.json',intent)
        for kind,request,response in [('volume',volume_request,dict(self.volume,name=volume_request['name'],attached_machine_id=None)),
                                      ('machine',machine_request,self.machine)]:
            creator['save'](journal/(kind+'.pending.json'),creator['envelope'](intent,dict(request=request)))
            creator['save'](journal/(kind+'.created.json'),creator['envelope'](intent,dict(id=response['id'],instance_id=response.get('instance_id'),request_sha256=creator['sha'](request),response=response)))
        receipt=creator['envelope'](intent,dict(outcome='ready-for-prepare',app=binding['app'],machine_id=self.mid,
            volume_id=self.vid,instance_id=self.machine['instance_id'],machine_name=self.machine['name'],
            donor_machine_id=donor['machine_id'],donor_volume_id=donor['volume_id'],snapshot_id='vs_old',
            config_sha256=self.m['sha'](self.m['canonical'](self.config)),
            env_sha256=self.m['sha'](self.m['canonical'](self.config.get('env') or {})),
            journal=str(journal),journal_sha256=creator['authority_digest'](journal)))
        creator['save'](journal/'result.json',receipt)
        self.request.pop('predecessor')
        self.request['ownership']=self.m['descriptor'](journal/'result.json')
        self.request['native']['config_sha256']=self.m['sha'](self.m['canonical'](self.config))
        self.calls=[];self.nonce=None;self.fault=None;self.foreign_changes=0
        self.transition_reads=[]
        self.lease_version=None
        self.enforce_exec_version=False
        self.remote_parent=self.root/'guest-data/.cloudbench-private'
        outer=self
        class Handler(http.server.BaseHTTPRequestHandler):
            def log_message(self,*args): pass
            def do_GET(self): self.handle_request('GET')
            def do_POST(self): self.handle_request('POST')
            def do_DELETE(self): self.handle_request('DELETE')
            def handle_request(self,method):
                path=self.path.split('/v1/apps/navi-whisper-lux-bench',1)[-1]
                raw=self.rfile.read(int(self.headers.get('Content-Length',0)))
                body=json.loads(raw) if raw else None
                nonce=self.headers.get('fly-machine-lease-nonce')
                outer.calls.append((method,path,copy.deepcopy(body),nonce))
                try:
                    status,value=outer.handle(method,path,body,nonce)
                except Exception as error:
                    status,value=500,{'error':type(error).__name__}
                raw=json.dumps(value).encode()
                self.send_response(status);self.send_header('Content-Length',str(len(raw)));self.end_headers();self.wfile.write(raw)
        self.server=http.server.ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.thread=threading.Thread(target=self.server.serve_forever);self.thread.start()
        self.addCleanup(self.stop_server)

    def stop_server(self):
        self.server.shutdown();self.thread.join();self.server.server_close()

    def write(self,name,value):
        self.m['save'](self.root/name,value)

    def desc(self,name): return self.m['descriptor'](self.root/name)

    def handle(self,method,path,body,nonce):
        own='/machines/'+self.mid
        if path=='/_test_ssh':
            args=body['args']
            if args[:3]==['ssh','sftp','put']:
                if args[3:10]!=['-a','navi-whisper-lux-bench','--machine',self.mid,'-q','-m','0600']:return 403,{}
                if self.fault=='sftp-unknown':return 503,{}
                remote=Path(args[11].replace('/data/.cloudbench-private',str(self.remote_parent)))
                if remote.exists() or remote.is_symlink():
                    return 200,dict(exit_code=1,stdout='',stderr='remote file already exists; flyctl sftp does not overwrite existing files for safety')
                with open(remote,'xb') as target:target.write(Path(args[10]).read_bytes())
                remote.chmod(0o600)
                if self.fault=='capsule-inode':
                    raw=remote.read_bytes();directory=remote.parent
                    directory.rename(directory.with_name(directory.name+'.old-inode'))
                    directory.mkdir(mode=0o700);remote.write_bytes(raw);remote.chmod(0o600)
                if self.fault=='capsule-symlink':remote.unlink();remote.symlink_to(args[10])
                if self.fault=='capsule-mode':remote.chmod(0o644)
                if self.fault=='capsule-hash':remote.write_bytes(b'wrong-hash')
                if self.fault=='capsule-directory-mode':remote.parent.chmod(0o755)
                if self.fault=='capsule-directory-symlink':
                    directory=remote.parent;other=directory.with_name(directory.name+'.original')
                    directory.rename(other);directory.symlink_to(other,target_is_directory=True)
                return 200,dict(exit_code=0,stdout='',stderr='')
            if args[:6]!=['ssh','console','-a','navi-whisper-lux-bench','--machine',self.mid] or args[6]!='-C':return 403,{}
            argv=shlex.split(args[7])
            if argv[:3]!=['timeout','--signal=TERM','5s'] or self.lease_version!=self.machine['instance_id'] or not self.nonce:return 409,{}
            if self.fault=='ssh-failed':return 503,{}
            if any(marker in argv[-1] for marker in ('cloudbench-capsule-stage-v1','cloudbench-capsule-directory-stage-v2','cloudbench-capsule-published-v1')):
                # Model guest root with the test process's UID on its real private filesystem.
                self.remote_parent.parent.mkdir(exist_ok=True)
                code=argv[-1].replace('/data/.cloudbench-private',str(self.remote_parent)).replace('s.st_uid==0','s.st_uid==os.getuid()').replace('a.st_uid==0','a.st_uid==os.getuid()')
                result=subprocess.run([sys.executable,'-c',code],capture_output=True,text=True,timeout=5)
                if result.returncode:return 200,dict(exit_code=result.returncode,stdout='',stderr='guest-staging-refused')
                value=json.loads(result.stdout)
                value['path']=value['path'].replace(str(self.remote_parent),'/data/.cloudbench-private')
                if 'uid' in value:value['uid']=0
                return 200,dict(exit_code=0,stdout=json.dumps(value),stderr='')
            status,answer=self.handle('POST',own+'/exec',dict(command=argv[3:],timeout=5),self.nonce)
            self.volume['bytes_used']=self.volume.get('bytes_used',0)+1024
            self.machine['events']=[{'type':'fixture-observation','sequence':self.foreign_changes}]
            self.machine['updated_at']=str(self.foreign_changes)
            if self.fault=='ssh-mount-drift':self.machine['config']['mounts'][0]['volume']='vol_foreign'
            return status,answer
        self.foreign_changes+=1  # Peers change on every read/write; no app-wide equality required.
        if method=='GET':
            if path==own: return 200,self.transition_reads.pop(0) if self.transition_reads else self.machine
            if path=='/machines/'+self.shared['id']: return 200,self.shared
            if path=='/volumes/'+self.vid: return 200,self.volume
            if path=='/volumes/'+self.vid+'/snapshots': return 200,self.snapshots
            return 403,{}
        if path==own+'/lease':
            if method=='POST':
                if self.nonce is not None and nonce!=self.nonce:return 409,{}
                self.nonce='lease-private';self.lease_version=self.machine['instance_id']
                version='wrong-version' if self.fault=='lease-version-wrong' and nonce else self.lease_version
                return 201,{'data':{'nonce':self.nonce,'version':version}}
            if method=='DELETE' and nonce==self.nonce:
                self.nonce=None;return 200,{}
            return 409,{}
        if nonce!=self.nonce or nonce is None:return 409,{}
        if method=='POST' and path==own:
            if body['current_version']!=self.machine['instance_id'] or self.fault=='cas':return 409,{}
            old=copy.deepcopy(self.machine)
            self.machine['config']=copy.deepcopy(body['config']);self.machine['instance_id']='NEW'+str(sum(1 for method,path,body,nonce in self.calls if method=='POST' and path==own))
            self.machine['image_ref']['digest']=body['config']['image'].rsplit('@',1)[1]
            if self.fault in ('transition','third-instance','third-config'):
                prior=dict(old,state='replacing')
                if self.fault=='third-instance':prior['instance_id']='UNKNOWN3'
                if self.fault=='third-config':prior['config']['env']['FOREIGN']='unknown'
                self.transition_reads=[prior]
            return 200,self.machine
        if method=='POST' and path in (own+'/start',own+'/stop'):
            self.machine['state']='started' if path.endswith('/start') else 'stopped';return 200,{}
        if method=='POST' and path==own+'/exec':
            if not isinstance(body.get('command'),list) or not all(isinstance(v,str) for v in body['command']):return 400,{}
            if self.enforce_exec_version and self.lease_version!=self.machine['instance_id']:
                return 409,{'error':'aborted: machine lease currently held by fixture-token'}
            if self.fault=='first-exec-409':return 409,{'error':'aborted: machine lease currently held by fixture-token'}
            job=dict(pid=42,birth='123',boot='a'*36)
            delivery=re.search(r'CLOUDBENCH-DELIVERY:[0-9]+',body['command'][-1])
            if delivery:return 200,{'exit_code':0,'stdout':delivery.group(0)+'\n'}
            if 'subprocess.Popen' in body['command'][-1]:return 200,{'exit_code':0,'stdout':json.dumps(job)}
            if self.fault=='guest-env-failure':
                failure=dict(schema='cloudbench-source-guest-v1',nonce=self.request['nonce'],guest_exit=1,
                    error='AssertionError',phase='preconditions',job=job,started_epoch=int(time.time()),finished_epoch=int(time.time()),
                    preconditions=dict(euid=0,machine_id=self.mid,data_mount=True,repo_physical='/data/repo',git_dir=True,
                        env_present={key:True for key in self.request['guest_env_sha256']},
                        guest_env_sha256={key:'7'*64 for key in self.request['guest_env_sha256']}))
                return 200,dict(exit_code=0,stdout=json.dumps(failure))
            guest=dict(schema='cloudbench-source-guest-v1',nonce=self.request['nonce'],source_ref=self.request['source_ref'],
                       machine_id=self.mid,node_fingerprint=self.request['node_fingerprint'],
                       python_fingerprint=self.request['python_fingerprint'],installed_node=self.request['node_fingerprint'],
                       image_node_fingerprint=self.request['node_fingerprint'],image_python_fingerprint=self.request['python_fingerprint'],
                       installed_python=self.request['python_fingerprint'],guest_env_sha256=self.request['guest_env_sha256'],
                       mount='/data',guest_exit=0,started_epoch=int(time.time()),finished_epoch=int(time.time()),job=job)
            if 'transport' in self.request:
                guest['transport']={key:self.request['transport'][key] for key in ('base_sha','workspace_patch_sha256','replayed_tree')}
            if self.request.get('guest_env_mode')==self.m['OWNED_MODE']:
                owned=self.m['owned_manifest'](self.request,dict(owner_token=self.owner,creation_nonce='6'*32))
                guest.update({key:owned[key] for key in self.m['OWNED_FIELDS']})
            if self.fault=='deps':guest['installed_node']='9'*64
            if self.fault=='env':guest['guest_env_sha256']=dict(guest['guest_env_sha256'],AGENTS_ENV_B64='8'*64)
            return 200,{'exit_code':0,'stdout':json.dumps(guest)}
        if method=='POST' and path=='/volumes/'+self.vid+'/snapshots':
            row=dict(id='vs_new',status='created',size=101,digest='2'*64,created_at=datetime.now(timezone.utc).isoformat())
            self.snapshots.append(row)
            if self.fault=='snapshot-msg':return 201,{'Msg':{'backup':{'graph_id':row['id'],'id':'45721','state':'prepare'}}}
            return 201,row
        return 403,{}

    def invoke(self,request_name='request.json',output_name='output',helper_path=None):
        self.write(request_name,self.request)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}')
        # Existing raw API resolves a flyctl binary even with a bearer credential.
        binary=self.root/'flyctl'
        binary.write_text('''#!/usr/bin/env python3
import json,os,sys,urllib.request
args=sys.argv[1:]
assert (len(args)==8 and args[:2]==['ssh','console']) or (len(args)==12 and args[:3]==['ssh','sftp','put'])
assert max(len(a.encode()) for a in args)<32768
request=urllib.request.Request(os.environ['FLY_API_HOSTNAME']+'/v1/apps/navi-whisper-lux-bench/_test_ssh',data=json.dumps({'args':args}).encode(),headers={'Content-Type':'application/json'})
try:
 with urllib.request.urlopen(request,timeout=10) as response:value=json.load(response)
except Exception:sys.exit(71)
sys.stdout.write(value.get('stdout',''));sys.stderr.write(value.get('stderr',''));sys.exit(value.get('exit_code',1))
''');binary.chmod(0o700)
        env['PATH']=str(self.root)+os.pathsep+env['PATH']
        return subprocess.run([sys.executable,str(helper_path or HERE/'cloudbench-prepare-source.py'),'--request',str(self.root/request_name),
                               '--output',str(self.root/output_name)],env=env,capture_output=True,text=True,timeout=35)

    def test_request_builder_fingerprints_oversized_git_pinned_helper_with_real_bash(self):
        root=self.root/'fingerprint-source';root.mkdir()
        for member in ('package.json','back-end/package.json','back-end/package-lock.json','front-end/package.json',
                       'agents/requirements.txt','scripts/cloudbench-fetch-ref.sh','scripts/cloudbench-sync-deps.sh'):
            target=root/member;target.parent.mkdir(parents=True,exist_ok=True)
            target.write_bytes((HERE.parent/member).read_bytes())
        helper=root/'scripts/lib/cloudbench-env.sh';helper.parent.mkdir()
        original=(HERE/'lib/cloudbench-env.sh').read_bytes()
        expected=subprocess.check_output(['bash','-euc',
            'source "$1"; cloudbench_node_dependency_fingerprint "$2"; cloudbench_manifest_fingerprint "$2" "${CLOUDBENCH_PYTHON_MANIFESTS[@]}"',
            'fingerprint-oracle',str(HERE/'lib/cloudbench-env.sh'),str(root)],text=True,timeout=20).splitlines()
        helper.write_bytes(original+b'\n#'+b'oversized pinned helper padding '*5000+
            b'\ntest "$(stat -c %a "${BASH_SOURCE[0]}")" = 600\n')
        self.assertGreater(helper.stat().st_size,131072)
        git=['git','-C',str(root)]
        subprocess.run(git+['init','-q'],check=True)
        subprocess.run(git+['add','.'],check=True)
        subprocess.run(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','pinned oversized helper'],check=True)
        ref=subprocess.check_output(git+['rev-parse','HEAD'],text=True).strip()
        self.write('fingerprint-build.json',dict(schema='cloudbench-image-build-v1',image_ref=self.image,source_sha=ref,source_dirty=False))
        self.write('fingerprint-env.json',self.request['guest_env_sha256'])
        self.write('fingerprint-protected.json',self.request['protected_resources'])
        value=self.m['build_request'](self.request['ownership']['path'],self.root/'fingerprint-build.json',root,ref,
            self.root/'fingerprint-env.json',self.root/'fingerprint-protected.json',self.root/'fingerprint-request.json')
        self.assertEqual([value['node_fingerprint'],value['python_fingerprint']],expected)
        self.assertEqual(value['scripts']['lib/cloudbench-env.sh'],self.m['sha'](helper.read_bytes()))
        self.assertFalse(self.calls)

    def test_generated_fetch_environment_uses_checkout_owner_with_real_local_git(self):
        if shutil.which('sudo') is None or subprocess.run(['sudo','-n','true'],capture_output=True).returncode:
            self.skipTest('local root identity fixture requires passwordless sudo')
        root=self.root/'fetch-identity';root.mkdir(mode=0o755);self.root.chmod(0o755)
        seed=root/'seed';seed.mkdir();git=['git','-C',str(seed)]
        def command(args):return subprocess.check_output(args,stderr=subprocess.DEVNULL,text=True).strip()
        command(git+['init','-q']);command(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','first'])
        origin=root/'origin.git';repo=root/'repo'
        command(['git','clone','-q','--bare',str(seed),str(origin)]);command(['git','clone','-q',str(origin),str(repo)])
        command(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','second'])
        target=command(git+['rev-parse','HEAD']);command(git+['push',str(origin),'HEAD:refs/heads/master'])
        program=ast.parse(self.m['guest_program'](self.request))
        body=next(node for node in program.body if isinstance(node,ast.Try)).body
        start=next(i for i,node in enumerate(body) if isinstance(node,ast.Assign)
                   and any(isinstance(t,ast.Name) and t.id in ('app_user','env') for t in node.targets))
        end=next(i for i,node in enumerate(body) if isinstance(node,ast.With)
                 and 'fetch.private.log' in ast.unparse(node))
        fragment=ast.unparse(ast.Module(body=body[start:end+1],type_ignores=[])).replace('/data/repo',str(repo))
        script=root/'cloudbench-fetch-ref.sh';script.write_bytes((HERE/'cloudbench-fetch-ref.sh').read_bytes())
        binary=root/'bin';binary.mkdir();user=subprocess.check_output(['id','-un'],text=True).strip()
        (binary/'gosu').write_text('#!/bin/sh\n[ "$1" = rose ] || exit 91\nshift\nexec /usr/bin/sudo -n -u '+shlex.quote(user)+' -- "$@"\n');(binary/'gosu').chmod(0o755)
        harness='''import os,pwd,pathlib,subprocess,base64,hashlib,types
pwd.getpwnam=lambda name:types.SimpleNamespace(pw_uid=OWNER,pw_dir='/home/rose')
r=dict(source_ref=TARGET,transport=None,guest_env_sha256={})
directory=pathlib.Path(ROOT);preconditions=dict(environment_contract=dict(provider_contract_verified=True))
FRAGMENT
'''.replace('OWNER',str(repo.stat().st_uid)).replace('TARGET',repr(target)).replace('ROOT',repr(str(root))).replace('FRAGMENT',fragment)
        run=subprocess.run(['sudo','-n','env','-i','PATH='+str(binary)+':/usr/bin:/bin','HOME='+str(root),
                            'python3','-c',harness],capture_output=True,text=True,timeout=20)
        self.assertEqual(run.returncode,0,run.stderr)
        self.assertEqual(command(['git','-C',str(repo),'rev-parse','HEAD']),target)
        self.assertFalse(self.calls)

    def test_generated_failure_diagnosis_seals_safe_auth_flags_without_secret_values(self):
        tree=ast.parse(self.m['guest_program'](self.request))
        function=next(node for node in tree.body if isinstance(node,ast.FunctionDef) and node.name=='failure_diagnosis')
        function=ast.parse(ast.unparse(function).replace('/data/.cloudbench-private',str(self.root/'private-root'))).body[0]
        raw=b'fatal: Authentication failed for https://secret-token-canary@example.invalid/private\n'
        (self.root/'fetch.private.log').write_bytes(raw)
        captured=[]
        namespace=dict(os=os,pathlib=__import__('pathlib'),subprocess=subprocess,hashlib=self.m['hashlib'],time=time,directory=self.root,
            phase='fetch',preconditions=dict(repo_uid=1001,app_uid=1001,chosen_app_user='rose',euid=0,machine_id=self.mid,data_mount=True),
            error=subprocess.CalledProcessError(128,['secret-argv-canary']),r=dict(self.request,machine_id=self.mid),job=dict(pid=42),started=1,
            save=lambda name,value:captured.append((name,value)))
        exec(compile(ast.Module(body=[function],type_ignores=[]),'<actual-generated-diagnosis>','exec'),namespace)
        failure=next(node for node in tree.body if isinstance(node,ast.Try)).handlers[0].body
        exec(compile(ast.Module(body=failure,type_ignores=[]),'<actual-generated-failure-result>','exec'),namespace)
        self.assertEqual(captured[0][0],'result.json');result=captured[0][1];diagnosis=result['failure_diagnosis']
        self.assertEqual(diagnosis['returncode'],128);self.assertEqual(diagnosis['chosen_app_user'],'rose')
        self.assertTrue(diagnosis['error_flags']['auth_refusal']);self.assertFalse(diagnosis['error_flags']['dubious_ownership'])
        log=diagnosis['logs']['fetch.private.log'];private=log.pop('private_copy');path=Path(private['path'])
        self.assertEqual(path.read_bytes(),raw);self.assertEqual(path.stat().st_mode&0o777,0o600)
        self.assertEqual(path.parent.stat().st_mode&0o777,0o700)
        self.assertEqual(private,dict(path=str(path),sha256=self.m['sha'](raw),size=len(raw),truncated=False))
        self.assertEqual(log,dict(size=len(raw),observed_bytes=len(raw),sha256=self.m['sha'](raw),complete=True))
        text=json.dumps(result);self.assertNotIn('secret-token-canary',text);self.assertNotIn('secret-argv-canary',text)
        self.assertNotIn('example.invalid',text);self.assertEqual(result['guest_exit'],1)
        again=namespace['failure_diagnosis'](namespace['error'])
        self.assertTrue(again['private_copy_unavailable']);self.assertNotIn('private_copy',again['logs']['fetch.private.log'])
        self.assertEqual(path.read_bytes(),raw)

    def test_real_cli_bounded_transport_full_chain_with_foreign_churn(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['machine_id'],self.mid);self.assertEqual(manifest['snapshot_id'],'vs_new')
        self.assertEqual(manifest['guest_env_sha256'],self.request['guest_env_sha256'])
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        self.assertGreater(self.foreign_changes,10)
        self.assertTrue(all(self.m['allowed_call'](method,path,self.mid,self.vid,(self.shared['id'],))
                            for method,path,body,nonce in self.calls))

    def test_ssh_cli_full_chain_and_typed_receipts_refuse_target_nonce_or_output_tamper(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.enforce_exec_version=True
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        def verify():return self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        verify()
        self.assertFalse(any(method=='POST' and p.endswith('/exec') for method,p,body,nonce in self.calls))
        target=next((self.root/'output/ssh').glob('*/request.json'));raw=target.read_bytes()
        answer_path=target.parent/'result.json';answer_raw=answer_path.read_bytes()
        for field in ('target','nonce','instance','mount'):
            wrong=json.loads(raw)
            if field=='target':wrong['argv'][5]='ffffffffffffff'
            elif field=='nonce':wrong['nonce']='foreign'
            elif field=='instance':wrong['instance_id']='UNKNOWN'
            else:wrong['before']['config']['mounts'][0]['volume']='vol_foreign'
            target.write_text(json.dumps(wrong))
            answer=json.loads(answer_raw);answer['request']=self.m['descriptor'](target);answer_path.write_text(json.dumps(answer))
            altered=copy.deepcopy(receipt);altered['ssh']=self.m['journal_index'](self.root/'output/ssh');path.write_text(json.dumps(altered))
            with self.assertRaises(ValueError):verify()
        target.write_bytes(raw);answer_path.write_bytes(answer_raw);path.write_text(json.dumps(receipt))
        answer=self.m['load'](target.parent/'result.json');log=Path(answer['stdout']['path']);log.write_text('forged-output')
        answer['stdout']=self.m['descriptor'](log);answer_path.write_text(json.dumps(answer))
        receipt['ssh']=self.m['journal_index'](self.root/'output/ssh');path.write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):verify()

    def test_ssh_guest_delivery_bounds_round_trips_and_chains_exact_fences(self):
        # Each SSH guest command costs a flyctl session plus bounded wire children
        # for its exact Machine/Volume fences. Small chunks or a redundant fresh
        # pre-read per chained command multiplied that cost until a preparation
        # exceeded its fixed budget under load. Bound the work, never the time.
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.enforce_exec_version=True
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        directory='/tmp/cloudbench-prepare-delivery-'+self.request['nonce']
        sent_request=self.m['load'](self.root/'request.json')
        commands=list(self.m['delivery_commands'](self.m['guest_program'](sent_request).encode(),directory))
        ends=[int(expected.rsplit(':',1)[1]) for command,expected in commands]
        blocks=[b-a for a,b in zip(ends[:-2],ends[1:-1])]
        self.assertTrue(len(blocks)>1 and all(size>=22500 for size in blocks[:-1]) and sum(blocks)==ends[-1],blocks)
        for command,expected in commands:
            self.assertLess(max(len(arg.encode()) for arg in self.m['ssh_argv']('navi-whisper-lux-bench',self.mid,command)),32768)
        receipt=self.m['load'](self.root/'output/result.json')
        rows=self.m['verify_journal'](receipt['journal'],self.mid,self.vid,(self.shared['id'],))
        ssh=sorted((self.root/'output/ssh').glob('*/request.json'),key=lambda p:int(p.parent.name))
        chain=[(self.m['load'](p),self.m['load'](p.parent/'result.json')) for p in ssh[:len(commands)+1]]
        self.assertEqual([sent['command'] for sent,answer in chain[:-1]],[command for command,expected in commands])
        own,volume='/machines/'+self.mid,'/volumes/'+self.vid
        for (previous_sent,previous),(sent,answer) in zip(chain,chain[1:]):
            self.assertEqual((sent['before'],sent['volume_before']),(previous['after'],previous['volume_after']))
            gap=[(r['method'],r['path']) for r in rows if previous['finished']<=r['started'] and r['finished']<=sent['started']
                 and r['path'] in (own,volume)]
            self.assertEqual(gap,[('GET',own),('GET',volume)])

    def test_ssh_native_mount_drift_refuses_and_never_publishes(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='ssh-mount-drift'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_ssh_failed_command_is_not_retried_and_owned_source_is_parked(self):
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='ssh-failed'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(sum(path=='/_test_ssh' for method,path,body,nonce in self.calls),1)
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        self.assertEqual(self.machine['config']['guest']['memory_mb'],2048)
        receipt=self.m['load'](self.root/'output/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['stopped_verified'])

    def test_completed_guest_old_msg_ack_failure_get_only_finalization(self):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='snapshot-msg'
        old=self.root/'historical-producer';old.mkdir()
        historical=json.loads(zlib.decompress(base64.b85decode(HISTORICAL_SNAPSHOT_B85)))
        self.assertEqual(set(historical),set(HISTORICAL_SNAPSHOT_SHA256))
        git=['git','--no-replace-objects','-C',str(HERE.parent)]
        index_env=dict(os.environ,GIT_INDEX_FILE=str(self.root/'historical-snapshot.index'))
        subprocess.run(git+['read-tree',self.request['source_ref']],env=index_env,check=True)
        for member,digest in HISTORICAL_SNAPSHOT_SHA256.items():
            raw=historical[member].encode();self.assertEqual(self.m['sha'](raw),digest,member)
            (old/member).write_bytes(raw)
            blob=subprocess.check_output(git+['hash-object','-w','--stdin'],input=raw).decode().strip()
            subprocess.run(git+['update-index','--add','--cacheinfo','100644,'+blob+',scripts/'+member],env=index_env,check=True)
        tree=subprocess.check_output(git+['write-tree'],env=index_env,text=True).strip()
        ref=subprocess.check_output(git+['-c','user.name=Fixture','-c','user.email=fixture@example.invalid',
            'commit-tree',tree,'-p',self.request['source_ref'],'-m','immutable historical snapshot ACK fixture'],text=True).strip()
        self.request['source_ref']=ref
        self.write('historical-snapshot-build.json',dict(schema='cloudbench-image-build-v1',image_ref=self.image,source_sha=ref,source_dirty=False))
        self.request['build']=self.desc('historical-snapshot-build.json')
        failed=self.invoke(helper_path=old/'cloudbench-prepare-source.py')
        self.assertNotEqual(failed.returncode,0)
        original={path:path.read_bytes() for path in (self.root/'output').rglob('*') if path.is_file()}
        self.assertFalse(self.m['load'](self.root/'output/result.json')['qualified'])
        self.assertEqual(len(self.snapshots),2)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        def finalize(name):
            return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'finalize-snapshot',
                '--request',str(self.root/'request.json'),'--failed-result',str(self.root/'output/result.json'),
                '--output',str(self.root/name)],env=env,capture_output=True,text=True,timeout=35)
        current=copy.deepcopy(self.machine)
        for kind in ('version','config','claim','volume'):
            self.machine=copy.deepcopy(current)
            if kind=='version':self.machine['instance_id']='UNKNOWN'
            elif kind=='config':self.machine['config']['env']['FOREIGN']='changed'
            elif kind=='claim':self.machine['config']['metadata']['cloudbench_source_consumer_'+'a'*32]='open'
            else:self.volume['encrypted']=False
            self.assertNotEqual(finalize('refuse-'+kind).returncode,0,kind)
            self.volume['encrypted']=True
        self.machine=copy.deepcopy(current);start=len(self.calls)
        answer=finalize('finalized');self.assertEqual(answer.returncode,0,answer.stderr)
        self.assertTrue(all(method=='GET' or path=='/machines/'+self.mid+'/lease' for method,path,body,nonce in self.calls[start:]))
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'finalized/result.json',self.root/'finalized/source-manifest.json',
            source_ref=ref,image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['snapshot_id'],'vs_new')
        creator=runpy.run_path(str(HERE/'cloudbench-prepare-source-create.py'));journal=self.root/'create'
        admitted=creator['retirement_successor'](SimpleNamespace(prepared_request=self.root/'request.json',
            prepared_result=self.root/'finalized/result.json',prepared_manifest=self.root/'finalized/source-manifest.json'),
            journal,creator['read'](journal/'intent.json'))
        self.assertEqual(admitted['instance_id'],manifest['instance_id'])
        self.assertEqual(sum(method=='POST' and path=='/volumes/'+self.vid+'/snapshots' for method,path,body,nonce in self.calls),1)
        self.assertEqual(sum(method=='POST' and path=='/machines/'+self.mid+'/start' for method,path,body,nonce in self.calls),1)
        result_path=self.root/'finalized/result.json';result=result_path.read_bytes()
        inventory_path=self.root/'finalized/final-inventory.json';inventory=inventory_path.read_bytes()
        for kind in ('incomplete','snapshot','guest'):
            value=json.loads(inventory)
            if kind=='incomplete':value['snapshots'][-1]['status']='running'
            elif kind=='snapshot':value['snapshots'][-1]['id']='vs_foreign'
            else:
                value=json.loads(result);value['guest']=value['before'];result_path.write_text(json.dumps(value))
            if kind!='guest':
                inventory_path.write_text(json.dumps(value));changed=json.loads(result);changed['inventory']=self.m['descriptor'](inventory_path);result_path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError,msg=kind):
                self.m['verify_prepared_source'](self.root/'request.json',result_path,self.root/'finalized/source-manifest.json',
                    source_ref=ref,image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
            result_path.write_bytes(result);inventory_path.write_bytes(inventory)
        for path,raw in original.items():self.assertEqual(path.read_bytes(),raw,str(path))

    def test_finalized_snapshot_resealed_digest_and_original_origin_refuse(self):
        self.test_completed_guest_old_msg_ack_failure_get_only_finalization()
        case=self;m=self.m;request=self.root/'request.json';rp=self.root/'finalized/result.json';mp=self.root/'finalized/source-manifest.json'
        result=m['load'](rp)
        def verify():return m['verify_prepared_source'](request,rp,mp,source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        saved={p:p.read_bytes() for base in (case.root/'finalized',case.root/'output') for p in base.rglob('*') if p.is_file()}
        with self.subTest(control='completed snapshot with empty digest must refuse'):
         inventory_path=Path(result['inventory']['path']);inventory=m['load'](inventory_path)
         for row in inventory['snapshots']:
          if row['id']=='vs_new':row['digest']=''
         inventory_path.write_text(json.dumps(inventory))
         for req in (case.root/'finalized/native').glob('*/request.json'):
          sent=m['load'](req)
          if sent['method']!='GET' or sent['path']!='/volumes/'+case.vid+'/snapshots':continue
          parsed=req.parent/'result.json';records=m['load'](parsed)
          for row in records:
           if row['id']=='vs_new':row['digest']=''
          parsed.write_text(json.dumps(records))
          wire=next(req.parent.glob('*-wire.json'));raw=m['load'](wire);body=json.dumps(records).encode();raw.update(body_b64=base64.b64encode(body).decode(),sha256=m['sha'](body));wire.write_text(json.dumps(raw))
         changed=copy.deepcopy(result);changed['inventory']=m['descriptor'](inventory_path);changed['journal']=m['journal_index'](case.root/'finalized/native');rp.write_text(json.dumps(changed))
         with self.assertRaises(ValueError):verify()
        for p,raw in saved.items():p.write_bytes(raw)
        with self.subTest(control='original origin missing schema and producer must refuse'):
         failed_path=Path(result['failed_result']['path']);failed=m['load'](failed_path);origin_path=Path(failed['origin']['path']);origin=m['load'](origin_path);origin.pop('schema');origin.pop('producer');origin_path.write_text(json.dumps(origin));failed['origin']=m['descriptor'](origin_path);failed_path.write_text(json.dumps(failed))
         intent_path=Path(result['intent']['path']);intent=m['load'](intent_path);intent['failed_result']=m['descriptor'](failed_path);intent_path.write_text(json.dumps(intent))
         changed=copy.deepcopy(result);changed['failed_result']=m['descriptor'](failed_path);changed['intent']=m['descriptor'](intent_path);rp.write_text(json.dumps(changed))
         with self.assertRaises(ValueError):verify()
        for p,raw in saved.items():p.write_bytes(raw)

    def test_normal_prepare_accepts_nested_snapshot_ack_without_rewriting_wire(self):
        self.fault='snapshot-msg';result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['snapshot_id'],'vs_new')
        rows=self.m['verify_journal'](self.m['load'](self.root/'output/result.json')['journal'],self.mid,self.vid,(self.shared['id'],))
        ack=next(row['response'] for row in rows if row['method']=='POST' and row['path']=='/volumes/'+self.vid+'/snapshots')
        self.assertEqual(ack,{'Msg':{'backup':{'graph_id':'vs_new','id':'45721','state':'prepare'}}})

    def owned_capsule_request(self,variant=None):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        index=self.root/'module-index'
        env=dict(os.environ,GIT_INDEX_FILE=str(index))
        git=['git','-C',str(HERE.parent)]
        subprocess.run(git+['read-tree',self.request['source_ref']],env=env,check=True)
        blob=subprocess.check_output(git+['hash-object','-w',str(HERE/'cloudbench-source-env.py')],text=True).strip()
        subprocess.run(git+['update-index','--add','--cacheinfo','100644,'+blob+',scripts/cloudbench-source-env.py'],env=env,check=True)
        tree=subprocess.check_output(git+['write-tree'],env=env,text=True).strip()
        ref=subprocess.check_output(git+['commit-tree',tree,'-p',self.request['source_ref'],'-m','isolated capsule producer fixture'],env=env,text=True).strip()
        fixture=runpy.run_path(str(HERE/'tests/cloudbench-source-env.test.py'))['CapsuleTest']();fixture.setUp();self.addCleanup(fixture.doCleanups)
        if variant is not None:
            for key in fixture.originals:
                original=fixture.originals[key].replace(fixture.secret.encode(),(fixture.secret+variant).encode())
                projected=fixture.projected[key].replace(fixture.secret.encode(),(fixture.secret+variant).encode())
                fixture.request['approved_inputs'][key]=fixture.write(key+'.approved',original)
                fixture.request['projected_inputs'][key]=fixture.write(key+'.projected',projected)
            fixture.secret+=variant
        fixture.request['binding'].update(owner_token=self.owner,create_nonce='6'*32,source_ref=ref,image_ref=self.image,
            node_fingerprint=self.request['node_fingerprint'],python_fingerprint=self.request['python_fingerprint'])
        fixture.build();capsule=json.loads(fixture.output.read_text())
        self.request.update(source_ref=ref,guest_transport='cloudbench-ssh-guest-v1',guest_env_mode=self.m['OWNED_MODE'],
            guest_env_capsule=self.m['descriptor'](fixture.output),guest_env_sha256=capsule['guest_env_sha256'])
        self.request['scripts']['cloudbench-source-env.py']=self.m['sha']((HERE/'cloudbench-source-env.py').read_bytes())
        return fixture,capsule

    def test_owned_capsule_sftp_cli_publication_and_no_secret_transport(self):
        fixture,capsule=self.owned_capsule_request()
        with patch.dict(os.environ,{'AGENTS_ENV_B64':'ambient-rotated','BACKEND_ENV_B64':'other-ambient'}):result=self.invoke()
        self.assertEqual(result.returncode,0,result.stderr)
        manifest=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(manifest['guest_env_capsule_binding'],capsule['binding'])
        final=self.remote_parent/'env'/ (self.request['guest_env_capsule']['sha256']+'.json')
        self.assertEqual(final.read_bytes(),fixture.output.read_bytes());self.assertEqual(final.stat().st_mode&0o777,0o600)
        receipt=self.m['load'](self.root/'output/result.json');self.assertIn('capsule_sftp',receipt);self.assertIn('capsule_ssh',receipt)
        for member in (self.root/'output').rglob('*'):
            if member.is_file():
                raw=member.read_bytes()
                self.assertNotIn(fixture.secret.encode(),raw)
                for value in capsule['env'].values():self.assertNotIn(value.encode(),raw)
        self.assertNotIn(fixture.secret,json.dumps(self.calls))
        path=self.root/'output/result.json';original=path.read_bytes()
        transfer=next((self.root/'output/capsule-sftp').glob('*/request.json'));raw=transfer.read_bytes()
        answer_path=transfer.parent/'result.json';answer_raw=answer_path.read_bytes()
        for kind in ('target','nonce','stage-inode','capsule-hash'):
            sent=json.loads(raw)
            if kind=='target':sent['argv'][6]='ffffffffffffff'
            elif kind=='nonce':sent['nonce']='foreign'
            elif kind=='stage-inode':sent['stage']['inode']+=1
            else:sent['capsule']['sha256']='0'*64
            transfer.write_text(json.dumps(sent));answer=json.loads(answer_raw);answer['request']=self.m['descriptor'](transfer)
            answer_path.write_text(json.dumps(answer));changed=json.loads(original)
            changed['capsule_sftp']=self.m['journal_index'](self.root/'output/capsule-sftp');path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError,msg=kind):
                self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
                    source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        transfer.write_bytes(raw);answer_path.write_bytes(answer_raw);path.write_bytes(original)
        # Equal before/after witnesses must prove encryption positively, rather
        # than accepting two consistently false observations in a resealed chain.
        native=self.m['verify_journal'](receipt['journal'],self.mid,self.vid,(self.shared['id'],))
        for row in native:
            if row['method']=='GET' and row['path']=='/volumes/'+self.vid:row['response']['encrypted']=False
        sent=json.loads(raw);sent['volume_before']['encrypted']=False
        transfer.write_text(json.dumps(sent));answer=json.loads(answer_raw)
        answer['request']=self.m['descriptor'](transfer);answer['volume_after']['encrypted']=False
        answer_path.write_text(json.dumps(answer))
        with self.assertRaisesRegex(ValueError,'encrypted Volume'):
            self.m['verify_ssh_journal'](self.m['journal_index'](transfer.parent.parent),native,self.request,
                self.m['described'](receipt['prestart']),sftp=True)
        transfer.write_bytes(raw);answer_path.write_bytes(answer_raw)

    def test_owned_capsule_unencrypted_volume_refuses_before_delivery(self):
        self.owned_capsule_request();self.volume['encrypted']=False
        result=self.invoke()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(path=='/_test_ssh' or method=='POST' and path=='/machines/'+self.mid
                             for method,path,body,nonce in self.calls))
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_owned_capsule_wrong_binding_or_symlink_refuses_before_native(self):
        fixture,capsule=self.owned_capsule_request()
        original=copy.deepcopy(self.request)
        for kind in ('owner_token','create_nonce','source_ref','image_ref','node_fingerprint','python_fingerprint','provider','hash','mode','symlink'):
            self.request=copy.deepcopy(original);wrong=copy.deepcopy(capsule)
            changed=self.root/('wrong-capsule-'+kind)
            if kind in wrong['binding']:wrong['binding'][kind]='f'*len(wrong['binding'][kind])
            if kind=='provider':wrong['providers']['backend']='steel' if wrong['providers']['backend']!='steel' else 'kernel'
            changed.write_text(json.dumps(wrong));changed.chmod(0o600)
            self.request['guest_env_capsule']=self.m['descriptor'](changed)
            if kind=='hash':self.request['guest_env_capsule']['sha256']='0'*64
            if kind=='mode':self.request['guest_env_mode']='foreign-mode'
            if kind=='symlink':
                changed.unlink();changed.symlink_to(fixture.output)
            result=self.invoke('request-'+kind+'.json','output-'+kind);self.assertNotEqual(result.returncode,0,kind);self.assertFalse(self.calls)

    def test_owned_capsule_unknown_sftp_outcome_never_retries_and_parks(self):
        self.owned_capsule_request();self.fault='sftp-unknown'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(sum(body.get('args',[])[:3]==['ssh','sftp','put'] for method,path,body,nonce in self.calls if path=='/_test_ssh'),1)
        self.assertEqual(self.machine['state'],'stopped');self.assertEqual(self.machine['config']['guest']['memory_mb'],2048)
        self.assertIsNone(self.nonce);self.assertFalse((self.root/'output/source-manifest.json').exists())
        failed=self.root/'output/result.json'
        recovered=self.invoke_ssh_recovery(failed,'recover-sftp-unknown')
        self.assertEqual(recovered.returncode,0,recovered.stderr)
        receipt=self.m['load'](self.root/'recover-sftp-unknown/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['filesystem_untrusted'])

    def test_owned_capsule_stage_inode_tamper_refuses_publication(self):
        self.owned_capsule_request();self.fault='capsule-inode'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_owned_capsule_uploaded_symlink_mode_or_hash_refuses_publication(self):
        self.owned_capsule_request()
        for fault in ('capsule-symlink','capsule-mode','capsule-hash'):
            with self.subTest(fault=fault):
                self.fault=fault;self.request['nonce']=self.m['secrets'].token_hex(16)
                result=self.invoke('request-'+fault+'.json','output-'+fault)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse((self.root/('output-'+fault)/'source-manifest.json').exists())
                self.assertEqual(self.machine['state'],'stopped')
                # Each operation requires exact current bootstrap authority;
                # restore only the fixture's original owned epoch for the next fault.
                self.machine['config']=copy.deepcopy(self.config);self.machine['instance_id']='OLD1'

    def test_owned_capsule_stage_directory_symlink_or_mode_refuses_publication(self):
        self.owned_capsule_request()
        for fault in ('capsule-directory-symlink','capsule-directory-mode'):
            with self.subTest(fault=fault):
                self.fault=fault;self.request['nonce']=self.m['secrets'].token_hex(16)
                result=self.invoke('request-'+fault+'.json','output-'+fault)
                self.assertNotEqual(result.returncode,0)
                self.assertFalse((self.root/('output-'+fault)/'source-manifest.json').exists())
                self.assertEqual(self.machine['state'],'stopped')
                self.machine['config']=copy.deepcopy(self.config);self.machine['instance_id']='OLD1'

    def test_two_owned_capsules_prepare_concurrently_with_different_approved_env(self):
        from concurrent.futures import ThreadPoolExecutor
        self.owned_capsule_request('A')
        peer=NativeLifecycle();peer.fixture_owner='b'*32;peer.setUp();self.addCleanup(peer.doCleanups)
        peer.owned_capsule_request('B')
        self.assertNotEqual(self.request['guest_env_sha256'],peer.request['guest_env_sha256'])
        with patch.dict(os.environ,{'AGENTS_ENV_B64':'ambient-rotated','BACKEND_ENV_B64':'ambient-also-rotated'}):
            with ThreadPoolExecutor(max_workers=2) as executor:
                answers=list(executor.map(lambda case:case.invoke(),(self,peer)))
        for case,result in zip((self,peer),answers):
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertEqual(case.m['load'](case.root/'output/source-manifest.json')['guest_env_capsule_sha256'],case.request['guest_env_capsule']['sha256'])

    def failed_ssh_guest(self):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        self.request['guest_transport']='cloudbench-ssh-guest-v1';self.fault='guest-env-failure'
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        self.assertIn('ssh',receipt)
        self.assertEqual(receipt['ssh'],self.m['journal_index'](self.root/'output/ssh'))
        self.assertTrue(receipt['stopped_verified']);self.assertFalse(receipt['qualified'])
        self.fault=None
        return path

    def invoke_ssh_recovery(self,failed,output='recovery-guest'):
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',
                 PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'request.json'),'--failed-result',str(failed),'--output',str(self.root/output)],
            env=env,capture_output=True,text=True,timeout=35)

    def test_failed_ssh_env_guest_seals_evidence_recovers_untrusted_and_fresh_contract_prepares(self):
        failed=self.failed_ssh_guest();oldraw=failed.read_bytes();oldrequest=(self.root/'request.json').read_bytes()
        result=self.invoke_ssh_recovery(failed);self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery-guest/result.json';receipt=self.m['load'](path)
        self.assertFalse(receipt['qualified']);self.assertFalse(receipt['credit_granted']);self.assertTrue(receipt['filesystem_untrusted'])
        self.assertFalse(receipt.get('legacy_unsealed_ssh',False))
        raw_receipt=path.read_bytes()
        for field in ('intent','filesystem_untrusted'):
            altered=copy.deepcopy(receipt);altered.pop(field);path.write_text(json.dumps(altered))
            with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
        path.write_bytes(raw_receipt)
        authority=self.m['resolve_bootstrap_ownership'](path)
        self.assertEqual(failed.read_bytes(),oldraw);self.assertEqual((self.root/'request.json').read_bytes(),oldrequest)
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            guest_env_sha256={key:'7'*64 for key in self.request['guest_env_sha256']},
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        self.write('fresh-request.json',self.request)
        env=dict(os.environ,FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        prepared=subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'--request',str(self.root/'fresh-request.json'),
            '--output',str(self.root/'fresh')],env=env,capture_output=True,text=True,timeout=35)
        self.assertEqual(prepared.returncode,0,prepared.stderr)
        self.m['verify_prepared_source'](self.root/'fresh-request.json',self.root/'fresh/result.json',self.root/'fresh/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        self.assertEqual(failed.read_bytes(),oldraw)

    def test_failed_ssh_guest_unknown_epoch_refuses_recovery_before_write(self):
        failed=self.failed_ssh_guest();original=copy.deepcopy(self.machine)
        for index,kind in enumerate(('unknown-epoch','consumer-claim','mount')):
            self.machine=copy.deepcopy(original)
            if kind=='unknown-epoch':self.machine['instance_id']='UNKNOWN3'
            elif kind=='consumer-claim':self.machine['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='claim'
            else:self.machine['config']['mounts'][0]['volume']='vol_foreign'
            before=len(self.calls);result=self.invoke_ssh_recovery(failed,'recovery-negative-'+str(index))
            self.assertNotEqual(result.returncode,0)
            self.assertTrue(all(method=='GET' or path.endswith('/lease') for method,path,body,nonce in self.calls[before:]))

    def test_failed_ssh_guest_altered_command_or_publication_refuses_pure_recovery(self):
        failed=self.failed_ssh_guest()
        self.write('output/source-manifest.json',{'forged':'published'})
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)
        (self.root/'output/source-manifest.json').unlink()
        path=next((self.root/'output/ssh').glob('*/request.json'));value=self.m['load'](path)
        value['command']=['echo','foreign'];value['argv']=self.m['ssh_argv']('navi-whisper-lux-bench',self.mid,value['command'])
        path.write_text(json.dumps(value));answer_path=path.parent/'result.json';answer=self.m['load'](answer_path)
        answer['request']=self.m['descriptor'](path);answer_path.write_text(json.dumps(answer))
        result=self.m['load'](failed);result['ssh']=self.m['journal_index'](self.root/'output/ssh');failed.write_text(json.dumps(result))
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)

    def test_real_http_known_cas_predecessor_replacing_waits_before_start(self):
        self.fault='transition'
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.assertEqual(self.machine['state'],'stopped')

    def test_exec_requires_supported_argv_and_lease_bound_to_current_cas_epoch(self):
        self.enforce_exec_version=True
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.assertTrue(any(path.endswith('/exec') for method,path,body,nonce in self.calls))

    def test_refresh_wrong_version_refuses_before_start_or_exec(self):
        self.fault='lease-version-wrong';result=self.invoke()
        self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith(('/start','/exec')) for method,path,body,nonce in self.calls))

    def test_resealed_start_before_lease_version_refresh_refuses(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/result.json';receipt=self.m['load'](path)
        rows=[]
        for p in (self.root/'output/native').glob('*/request.json'):
            sent=self.m['load'](p);wire=next(p.parent.glob('*-wire.json'));record=self.m['load'](wire)
            rows.append((self.m['load'](p.parent/'transport-start.json')['monotonic_ns'],p,sent,wire,record))
        rows.sort()
        start=next(row for row in rows if row[2]['path'].endswith('/start'))
        renewal=next(row for row in rows if row[2]['method']=='POST' and row[2]['path'].endswith('/lease') and row[2]['headers'])
        self.assertLess(renewal[0],start[0])
        stamp=self.m['load'](renewal[1].parent/'transport-start.json');stamp['monotonic_ns']=start[4]['monotonic_ns']+1
        (renewal[1].parent/'transport-start.json').write_text(json.dumps(stamp))
        renewal[4]['monotonic_ns']=stamp['monotonic_ns']+1;renewal[3].write_text(json.dumps(renewal[4]))
        receipt['journal']=self.m['journal_index'](self.root/'output/native');path.write_text(json.dumps(receipt))
        with self.assertRaisesRegex(ValueError,'version'):
            self.m['verify_prepared_source'](self.root/'request.json',path,self.root/'output/source-manifest.json',
                source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)

    def test_unknown_replacement_instance_never_starts(self):
        self.fault='third-instance';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,body,nonce in self.calls))

    def test_unknown_replacement_config_never_starts(self):
        self.fault='third-config';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path.endswith('/start') for method,path,body,nonce in self.calls))

    def test_known_predecessor_cannot_extend_absolute_transition_deadline(self):
        row=copy.deepcopy(self.machine);row['state']='replacing'
        calls=[]
        def request(method,path):
            calls.append((method,path))
            return row if '/machines/' in path else self.volume
        clock=iter((0,60,120))
        with patch.dict(self.m['wait_state'].__globals__,time=SimpleNamespace(monotonic=lambda:next(clock),sleep=lambda _:None)):
            with self.assertRaisesRegex(ValueError,'deadline'):
                self.m['wait_state'](SimpleNamespace(request=request),self.request,self.manifest,
                    dict(self.config,image=self.image), 'stopped','ACK2',120,prior=self.machine)
        self.assertEqual(len(calls),4)
        self.assertTrue(all(method=='GET' for method,path in calls))

    def failed_prestart(self):
        self.volume.update(name='cbs_'+self.owner[:26],encrypted=True)
        self.write('failed-request.json',self.request)
        binary=self.root/'flyctl';binary.write_text('#!/bin/sh\nexit 97\n');binary.chmod(0o700)
        env=dict(FLY_API_TOKEN='fixture-private',FLY_API_HOSTNAME=f'http://127.0.0.1:{self.server.server_port}',
                 PATH=str(self.root)+os.pathsep+os.environ['PATH'])
        def fail(*args,**kwargs):raise ValueError('injected acknowledged-CAS prestart failure')
        with patch.dict(os.environ,env),patch.dict(self.m['prepare'].__globals__,wait_state=fail):
            with self.assertRaises(ValueError):self.m['prepare'](self.root/'failed-request.json',self.root/'failed')
        return env

    def invoke_recovery(self,env,output='recovery'):
        return subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'failed-request.json'),'--failed-result',str(self.root/'failed/result.json'),
            '--output',str(self.root/output)],env=dict(os.environ,**env),capture_output=True,text=True,timeout=35)

    def test_real_http_failed_cas_recovery_fresh_prepare_preserves_old_false(self):
        env=self.failed_prestart()
        originals={p:p.read_bytes() for p in (self.root/'failed').rglob('*') if p.is_file()}
        originals[self.root/'failed-request.json']=(self.root/'failed-request.json').read_bytes()
        result=self.invoke_recovery(env);self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';receipt=self.m['load'](path)
        self.assertFalse(receipt['qualified']);self.assertFalse(receipt['credit_granted'])
        authority=self.m['resolve_bootstrap_ownership'](path)
        self.assertEqual(authority['machine']['config']['guest']['memory_mb'],2048)
        self.assertEqual(authority['machine']['config']['guest']['cpus'],1)
        self.assertEqual(authority['original_creator'],self.request['ownership'])
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        prepared=self.invoke();self.assertEqual(prepared.returncode,0,prepared.stderr)
        self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
        for p,raw in originals.items():self.assertEqual(p.read_bytes(),raw)
        self.assertFalse(self.m['load'](self.root/'failed/result.json')['qualified'])

    def test_recovery_unknown_epoch_refuses_without_parking_or_guest(self):
        env=self.failed_prestart();self.machine['instance_id']='UNKNOWN3'
        start=len(self.calls);result=self.invoke_recovery(env)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(all(path.endswith('/lease') or method=='GET' for method,path,body,nonce in self.calls[start:]))

    def test_recovery_result_and_original_authority_tamper_refuse(self):
        env=self.failed_prestart();result=self.invoke_recovery(env)
        self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';raw=path.read_bytes()
        for field,value in [('qualified',True),('credit_granted',True),('nonce','d'*32)]:
            changed=json.loads(raw);changed[field]=value;path.write_text(json.dumps(changed))
            with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
        path.write_bytes(raw)
        failed=self.root/'failed/result.json';original=failed.read_bytes()
        changed=json.loads(original);changed['qualified']=True;failed.write_text(json.dumps(changed))
        with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)

    def test_recovery_resealed_lease_and_cas_version_tamper_refuse(self):
        env=self.failed_prestart();result=self.invoke_recovery(env)
        self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'recovery/result.json';original=path.read_bytes()
        for member in (self.root/'recovery/native').glob('*/request.json'):
            request=self.m['load'](member)
            if request['method']=='POST' and request['path']=='/machines/'+self.mid:
                raw=member.read_bytes()
                for field in ('lease','version'):
                    wrong=copy.deepcopy(request)
                    if field=='lease':wrong['headers']['fly-machine-lease-nonce']='foreign-lease'
                    else:wrong['body']['current_version']='UNKNOWN3'
                    member.write_text(json.dumps(wrong))
                    receipt=json.loads(original);receipt['journal']=self.m['journal_index'](self.root/'recovery/native')
                    path.write_text(json.dumps(receipt))
                    with self.assertRaises(ValueError):self.m['verify_recovered_bootstrap'](path)
                member.write_bytes(raw);path.write_bytes(original)

    def test_recovery_published_claim_refuses_before_parking(self):
        env=self.failed_prestart();self.machine['config']['metadata']['cloudbench_source_consumer_'+'f'*32]='claim'
        start=len(self.calls);result=self.invoke_recovery(env)
        self.assertNotEqual(result.returncode,0)
        self.assertTrue(all(path.endswith('/lease') or method=='GET' for method,path,body,nonce in self.calls[start:]))

    def test_nested_recovery_after_first_exec_rejected_and_cleanly_parked(self):
        env=self.failed_prestart();self.assertEqual(self.invoke_recovery(env).returncode,0)
        path=self.root/'recovery/result.json';authority=self.m['resolve_bootstrap_ownership'](path)
        original_creator=authority['original_creator']
        self.request=dict(self.request,nonce='e'*32,ownership=self.m['descriptor'](path),
            native=dict(self.request['native'],instance_id=authority['machine']['instance_id'],
                        config_sha256=self.m['sha'](self.m['canonical'](authority['machine']['config']))))
        self.fault='first-exec-409';failed=self.invoke();self.assertNotEqual(failed.returncode,0)
        old=self.root/'output/result.json';oldraw=old.read_bytes()
        self.assertTrue(self.m['load'](old)['stopped_verified'])
        execs=[row for row in self.calls if row[0]=='POST' and row[1].endswith('/exec')]
        self.assertEqual(len(execs),1)
        self.fault=None
        result=subprocess.run([sys.executable,str(HERE/'cloudbench-prepare-source.py'),'recover-bootstrap',
            '--request',str(self.root/'request.json'),'--failed-result',str(old),'--output',str(self.root/'recovery52')],
            env=dict(os.environ,**env),capture_output=True,text=True,timeout=35)
        self.assertEqual(result.returncode,0,result.stderr)
        value=self.m['resolve_bootstrap_ownership'](self.root/'recovery52/result.json')
        self.assertEqual(value['original_creator'],original_creator)
        self.assertEqual(old.read_bytes(),oldraw)
        self.assertFalse(self.m['load'](self.root/'recovery52/result.json')['qualified'])

    def test_exec_rejection_recovery_refuses_nonbootstrap_command(self):
        self.fault='first-exec-409';result=self.invoke();self.assertNotEqual(result.returncode,0)
        failed=self.root/'output/result.json';receipt=self.m['load'](failed)
        for p in (self.root/'output/native').glob('*/request.json'):
            row=self.m['load'](p)
            if row['path'].endswith('/exec'):
                row['body']['command']=['echo','not-the-bootstrap'];p.write_text(json.dumps(row))
        receipt['journal']=self.m['journal_index'](self.root/'output/native');failed.write_text(json.dumps(receipt))
        with self.assertRaises(ValueError):self.m['prestart_failure'](self.root/'request.json',failed)

    def test_resealed_manifest_cannot_change_prepared_guest_environment(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        path=self.root/'output/source-manifest.json'
        manifest=self.m['load'](path)
        manifest['guest_env_sha256']['AGENTS_ENV_B64']='7'*64
        self.m['save'](self.root/'changed-manifest.json',manifest)
        receipt=self.m['load'](self.root/'output/result.json')
        receipt['manifest']=self.m['descriptor'](self.root/'changed-manifest.json')
        self.m['save'](self.root/'output/resealed-result.json',receipt)
        with self.assertRaises(ValueError):
            self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/resealed-result.json',
                self.root/'changed-manifest.json',source_ref=self.request['source_ref'],image_ref=self.image,
                node_fingerprint='b'*64,python_fingerprint='c'*64)

    def test_guest_dependency_failure_stops_owned_target_and_emits_failed_receipt(self):
        self.fault='deps';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.machine['state'],'stopped');self.assertIsNone(self.nonce)
        receipt=self.m['load'](self.root/'output/result.json')
        self.assertFalse(receipt['qualified']);self.assertTrue(receipt['stopped_verified'])
        self.assertFalse((self.root/'output/source-manifest.json').exists())

    def test_independent_new_set_publishes_observed_set_instead_of_donor(self):
        self.request['node_fingerprint']='4'*64;self.request['python_fingerprint']='5'*64
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        successor=self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',
            self.root/'output/source-manifest.json',source_ref=self.request['source_ref'],image_ref=self.image,
            node_fingerprint='4'*64,python_fingerprint='5'*64)
        self.assertEqual(successor['node_fingerprint'],'4'*64)
        self.assertEqual(successor['python_fingerprint'],'5'*64)

    def test_exact_source_patch_contract_reconstructs_and_attests_tree(self):
        patch=self.root/'workspace.patch'
        patch.write_text('diff --git a/scripts/private-source-probe b/scripts/private-source-probe\nnew file mode 100644\n--- /dev/null\n+++ b/scripts/private-source-probe\n@@ -0,0 +1 @@\n+owned source transport probe\n')
        patch.chmod(0o600)
        env=dict(os.environ,GIT_INDEX_FILE=str(self.root/'replay.index'))
        git=['git','-C',str(HERE.parent)]
        subprocess.run(git+['read-tree',self.request['source_ref']],env=env,check=True)
        subprocess.run(git+['apply','--cached','--binary',str(patch)],env=env,check=True)
        tree=subprocess.check_output(git+['write-tree'],env=env,text=True).strip()
        self.request['transport']=dict(sealed_at=time.time(),token=self.request['nonce'],
            source=dict(head=self.request['source_ref'],digest='8'*64),workspace_root=str(HERE.parent),
            base_sha=self.request['source_ref'],workspace_patch_sha256=self.m['sha'](patch.read_bytes()),
            patch=str(patch),replayed_tree=tree)
        self.request['scripts']['cloudbench-prepare-patch.sh']=self.m['sha'](self.m['source_bytes'](HERE.parent,tree,'cloudbench-prepare-patch.sh'))
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        self.m['verify_prepared_source'](self.root/'request.json',self.root/'output/result.json',self.root/'output/source-manifest.json',
            source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)

    def test_stale_cas_never_starts_or_snapshots(self):
        self.fault='cas';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(path.endswith(('/start','/exec','/snapshots')) and method=='POST' for method,path,body,nonce in self.calls))

    def test_environment_mismatch_fails_closed(self):
        self.fault='env';result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertEqual(self.machine['state'],'stopped')

    def test_protected_volume_alias_refuses_before_any_native_io(self):
        self.request['protected_resources']['811d632f2650e8']=self.vid
        result=self.invoke();self.assertNotEqual(result.returncode,0);self.assertEqual(self.calls,[])

    def test_wrong_protected_mapping_refuses_before_native_construction(self):
        for index, identity in enumerate(self.m['PROTECTED_RESOURCES']):
            with self.subTest(machine=identity):
                request=copy.deepcopy(self.request)
                request['protected_resources'][identity]='vol_wrong'
                request_path=self.root/('wrong-protected-'+str(index)+'.json')
                self.m['save'](request_path,request)
                def factory(*args):
                    raise AssertionError('native constructed for wrong protected mapping')
                with self.assertRaisesRegex(ValueError,'exact protected Machine/Volume bindings'):
                    self.m['prepare'](request_path,self.root/('wrong-protected-output-'+str(index)),factory)
                self.assertFalse((self.root/('wrong-protected-output-'+str(index))).exists())
                self.assertEqual(self.calls,[])

    def test_real_subprocess_chunk_transport_does_not_exceed_linux_argument_limit(self):
        program=self.m['guest_program'](self.request)
        compile(program,'guest-worker','exec')
        self.assertGreater(len(program.encode()),128*1024)
        raw=('import hashlib\npayload='+repr(program)+'\nprint(hashlib.sha256(payload.encode()).hexdigest())\n').encode()
        directory=self.root/'delivery'
        for command,expected in self.m['delivery_commands'](raw,directory):
            self.assertLess(max(len(arg.encode()) for arg in command),32768)
            result=subprocess.run(command,capture_output=True,text=True,timeout=5)
            self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),expected)
        result=subprocess.run([sys.executable,str(directory/'worker.py')],capture_output=True,text=True,timeout=5)
        self.assertEqual(result.returncode,0,result.stderr);self.assertEqual(result.stdout.strip(),self.m['sha'](program.encode()))

    def test_resealed_semantic_journal_tampering_is_rejected(self):
        result=self.invoke();self.assertEqual(result.returncode,0,result.stderr)
        result_path=self.root/'output/result.json'; original_result=result_path.read_bytes()
        requests=list((self.root/'output/native').glob('*/request.json'))
        controls=[]
        for path in requests:
            sent=self.m['load'](path)
            if sent['method']=='POST' and sent['path']=='/machines/'+self.mid:
                wrong=copy.deepcopy(sent);wrong['body']['current_version']='forged-version';controls.append((path,wrong))
            if sent['method']=='POST' and sent['path'].endswith('/exec') and not any(v['path'].endswith('/exec') for p,v in controls):
                wrong=copy.deepcopy(sent);wrong['headers']={};controls.append((path,wrong))
        self.assertGreaterEqual(len(controls),2)
        for path,wrong in controls:
            original=path.read_bytes()
            try:
                path.write_text(json.dumps(wrong))
                receipt=json.loads(original_result);receipt['journal']=self.m['journal_index'](self.root/'output/native')
                result_path.write_text(json.dumps(receipt))
                with self.assertRaises(ValueError):
                    self.m['verify_prepared_source'](self.root/'request.json',result_path,self.root/'output/source-manifest.json',
                        source_ref=self.request['source_ref'],image_ref=self.image,node_fingerprint='b'*64,python_fingerprint='c'*64)
            finally:
                path.write_bytes(original);result_path.write_bytes(original_result)

    def test_wrong_mount_refuses_before_image_start(self):
        self.machine['config']['mounts']=[{'volume':'vol_foreign','path':'/data'}]
        result=self.invoke();self.assertNotEqual(result.returncode,0)
        self.assertFalse(any(method=='POST' and path=='/machines/'+self.mid for method,path,body,nonce in self.calls))

    def test_before_effects_origin_callback_precedes_api_construction(self):
        self.write('request.json',self.request)
        seen=[]
        def anchor(path):
            origin=self.m['load'](path)
            self.assertEqual(origin['producer']['pid'],os.getpid());seen.append(origin)
            raise RuntimeError('fixture anchor refusal')
        def factory(*args): raise AssertionError('native constructed before refused parent anchor')
        with self.assertRaisesRegex(RuntimeError,'anchor refusal'):
            self.m['prepare'](self.root/'request.json',self.root/'anchored',factory,before_effects=anchor)
        self.assertEqual(len(seen),1);self.assertEqual(self.calls,[])

    def test_expired_native_lease_cannot_be_renewed_or_used(self):
        api=object.__new__(self.m['ScopedNative']);api.lost=False;api.nonce='owned';api.lease_end=time.monotonic()+1
        with self.assertRaises(ValueError):api.renew()


if __name__ == '__main__': unittest.main()
