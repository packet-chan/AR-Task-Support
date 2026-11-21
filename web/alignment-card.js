// The canvas, hit targets, focus hint, lock and grip belong to the capture panel.
const glyphs = new Map([
  ["本体から始める","next"], ["重なりを確認","check"], ["モデル動作","skip"],
  ["前のSTEP","prev"], ["次のSTEP","next"], ["その他の操作","more"],
  ["案内に戻る","back"], ["STEPに戻る","back"], ["部品の案内に戻る","back"],
  ["前の一覧","prev"], ["次の一覧","next"], ["手順・注意","book"],
  ["位置を取り直す","retry"], ["この範囲をやり直す","retry"], ["記録して終了","exit"]
]);

export function drawAlignmentCard({ctx,buttons,box,icon,label,wrap,focus,usingHands,image,figure},view) {
  const {title,body,progress,list,main,mini,message,page,advance} = view;
  const ink = "#f4f7fb", accent = "#b4def5";
  label(title,32,65,42,ink,progress ? 672 : 896,650);
  ctx.textAlign = "right";
  if (progress) label(progress,928,63,30,accent,228,600);
  ctx.textAlign = "left";
  if (view.expanded && view.zoom === 1)
    label("読みたい場所を押すと4倍",285,62,25,accent,396);
  const toolbar = main.slice();
  function button(action,x,y,w,h,primary = false) {
    const id = "action-"+action.label, hot = focus === id;
    buttons.push({id,name:action.label,run:action.fn,x,y,w,h});
    box(x,y,w,h,20,hot ? ink : primary ? accent : "#354553");
    const color = hot || primary ? "#202b36" : ink, glyph = glyphs.get(action.label);
    const inset = glyph ? 58 : 16;
    if (glyph) icon(glyph,x+31,y+h/2,30,color);
    const width = w-inset-14;
    let font = 29, rows;
    do {
      ctx.font = "600 "+font+"px system-ui, sans-serif";
      rows = wrap(action.label,width);
      if (rows.length*(font+4) <= h-12 || font <= 20) break;
      font -= 2;
    } while (true);
    const baseline = y+h/2-(rows.length-1)*(font+4)/2+font*.33;
    rows.forEach((row,i) => label(row,x+inset,baseline+i*(font+4),font,color,width,600));
  }
  const diagram = view.diagram;
  function illustration(x,y,w,h) {
    if (!figure) {
      label(figure === false ? "図を読み込めません" : "図を読み込み中…",x+8,y+h/2,25,ink,w-16);
      return;
    }
    ctx.save();
    ctx.beginPath(); ctx.rect(x,y,w,h); ctx.clip();
    if (view.zoom > 1) {
      const scale = Math.min(w/figure.naturalWidth,h/figure.naturalHeight)*view.zoom;
      const iw=figure.naturalWidth*scale, ih=figure.naturalHeight*scale;
      const offset = (extent,area,index) => extent <= area ? (area-extent)/2 : (area-extent)*index/(view.zoom-1);
      image(figure,x+offset(iw,w,view.tile%view.zoom),y+offset(ih,h,Math.floor(view.tile/view.zoom)),iw,ih,diagram.point);
    } else image(figure,x,y,w,h,diagram.point);
    ctx.restore();
  }
  if (view.expanded && diagram) {
    const x=20,y=76,w=920,h=302;
    illustration(x,y,w,h);
    if (view.zoom === 1 && figure) {
      const scale = Math.min(w/figure.naturalWidth,h/figure.naturalHeight);
      const iw=figure.naturalWidth*scale, ih=figure.naturalHeight*scale;
      for (let i=0;i<16;i++) buttons.push({id:"read-"+i,name:"ここを4倍に拡大",run:() => view.readTile(i),
        x:x+(w-iw)/2+(i%4)*iw/4,y:y+(h-ih)/2+Math.floor(i/4)*ih/4,w:iw/4,h:ih/4});
    }
  } else if (list.length) {
    if (body) label(body,32,119,27,accent,896);
    list.forEach((a,i) => button(a,32+(i%2)*454,134+Math.floor(i/2)*100,440,90));
  } else {
    const width = diagram ? 478 : 896, font = diagram ? 33 : 38, lineHeight = diagram ? 41 : 50;
    if (diagram) {
      illustration(534,77,394,220);
      const name = "図を拡大";
      buttons.push({id:"diagram",name,run:view.openFigure,x:524,y:76,w:404,h:243});
      label(name,545,317,24,focus==="diagram" ? ink : accent,360);
    }
    ctx.font = "500 "+font+"px system-ui, sans-serif";
    const rows = wrap(body,width), per = 4, pages = Math.max(1,Math.ceil(rows.length/per));
    const pos = page%pages;
    rows.slice(pos*per,(pos+1)*per).forEach((row,i) => label(row,32,135+i*lineHeight,font,ink,width));
    if (pages > 1) {
      const name = "続きを読む "+(pos+1)+"/"+pages;
      buttons.push({id:"read-body",name,run:() => advance(pages),x:24,y:85,w:width+8,h:224});
      label(name,32,301,24,focus === "read-body" ? ink : accent,width);
    }
    if (message) label(message,32,329,27,"#ffce91",896);
  }
  const pointing = view.pointing && toolbar.length <= 2;
  const left = pointing ? 348 : 32;
  if (pointing) {
    box(33,402,16,16,8,"#52dcff");
    label(usingHands ? "ピンチで記録" : "トリガーで記録",63,419,30,ink,267);
  }
  const width = (928-left-16*(toolbar.length-1))/Math.max(1,toolbar.length);
  toolbar.forEach((a,i) => button(a,left+i*(width+16),view.expanded ? 385 : 353,width,view.expanded ? 72 : 101,
    i === 0 && ["本体から始める","重なりを確認","この範囲をやり直す","次のSTEP","モデル動作"].includes(a.label)));
}
