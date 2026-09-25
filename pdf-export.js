/* TLWC PDF export. Local PDFLib UMD required; local fontkit is optional. */
(function (global) {
  'use strict';
  const VERSION = '1.0.0';
  const FONT_DEFAULTS = {
    Bodoni: ['Times-Roman', 'serif', 'normal', 'normal'],
    BodoniI: ['Times-Italic', 'serif', 'normal', 'italic'],
    Body: ['Times-Roman', 'serif', 'normal', 'normal'],
    BodyB: ['Times-Bold', 'serif', 'bold', 'normal'],
    BodyI: ['Times-Italic', 'serif', 'normal', 'italic'],
    Sans: ['Helvetica', 'sans-serif', 'normal', 'normal'],
    SansB: ['Helvetica-Bold', 'sans-serif', 'bold', 'normal'],
    Condensed: ['Helvetica', 'sans-serif', 'normal', 'normal'],
    FuturaB: ['Helvetica-Bold', 'sans-serif', 'bold', 'normal']
  };
  const clamp = (n, low, high) => Math.max(low, Math.min(high, n));
  const num = (n, fallback) => Number.isFinite(Number(n)) ? Number(n) : fallback;
  const yieldFrame = () => new Promise(resolve => setTimeout(resolve, 0));
  function err(message, cause) { const e = new Error(message); if (cause) e.cause = cause; return e; }
  function assetsOf(project) {
    return Array.isArray(project.assets)
      ? Object.fromEntries(project.assets.map(a => [a.id, a])) : (project.assets || {});
  }
  function safeURL(value) {
    const s = String(value || '').trim();
    return /^(https?:\/\/|mailto:|tel:)/i.test(s) ? s : null;
  }
  function bytesFromDataURL(src) {
    const match = /^data:([^,]*),(.*)$/s.exec(src || '');
    if (!match) throw err('An asset is not embedded as a data URL.');
    if (/;base64/i.test(match[1])) {
      const s = atob(match[2].replace(/\s/g, ''));
      return Uint8Array.from(s, c => c.charCodeAt(0));
    }
    return new TextEncoder().encode(decodeURIComponent(match[2]));
  }
  async function assetBytes(src) {
    if (/^data:/i.test(src || '')) return bytesFromDataURL(src);
    if (/^blob:/i.test(src || '')) {
      const r = await fetch(src); if (!r.ok) throw err('An imported asset is no longer available.');
      return new Uint8Array(await r.arrayBuffer());
    }
    throw err('PDF export requires embedded local assets. Import this image or font first.');
  }
  function makeCanvas(w, h, scale) {
    const c = document.createElement('canvas');
    const s = Math.min(scale || 2, 8192 / Math.max(w, h));
    c.width = Math.max(1, Math.ceil(w * s)); c.height = Math.max(1, Math.ceil(h * s));
    const ctx = c.getContext('2d'); if (!ctx) throw err('This browser cannot render PDF images.');
    ctx.scale(c.width / w, c.height / h);
    return { canvas: c, ctx, width: w, height: h };
  }
  function canvasBytes(canvas) { return bytesFromDataURL(canvas.toDataURL('image/png')); }
  function color(value, P) {
    if (value == null || value === '' || /^(none|transparent)$/i.test(value)) return null;
    const c = document.createElement('canvas'); c.width = c.height = 1;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#010203'; ctx.fillStyle = String(value);
    if (ctx.fillStyle === '#010203' && !/^#010203$/i.test(String(value))) {
      ctx.fillStyle = '#040506'; ctx.fillStyle = String(value);
      if (ctx.fillStyle === '#040506') throw err('Unsupported colour: ' + value);
    }
    ctx.fillRect(0, 0, 1, 1);
    const p = ctx.getImageData(0, 0, 1, 1).data;
    return { color: P.rgb(p[0] / 255, p[1] / 255, p[2] / 255), alpha: p[3] / 255 };
  }
  function geometry(el, pageHeight) {
    const w = Math.max(0, num(el.w, 0)), h = Math.max(0, num(el.h, 0));
    const rad = -num(el.rotation, 0) * Math.PI / 180;
    const a = Math.cos(rad), b = Math.sin(rad), c = -b, d = a;
    const x = num(el.x, 0) + w / 2, y = pageHeight - num(el.y, 0) - h / 2;
    return { w, h, matrix: [a, b, c, d, x - a * w / 2 - c * h / 2, y - b * w / 2 - d * h / 2] };
  }
  function framePath(P, w, h, radius, shape) {
    if(shape==='ellipse'){const x=w/2,y=h/2,k=.5522847498;return [P.moveTo(w,y),P.appendBezierCurve(w,y+y*k,x+x*k,h,x,h),P.appendBezierCurve(x-x*k,h,0,y+y*k,0,y),P.appendBezierCurve(0,y-y*k,x-x*k,0,x,0),P.appendBezierCurve(x+x*k,0,w,y-y*k,w,y),P.closePath()];}

    const r = clamp(num(radius, 0), 0, Math.min(w, h) / 2);
    if (!r) return [P.rectangle(0, 0, w, h)];
    const k = r * .5522847498;
    return [P.moveTo(r, 0), P.lineTo(w - r, 0), P.appendBezierCurve(w - r + k, 0, w, r - k, w, r),
      P.lineTo(w, h - r), P.appendBezierCurve(w, h - r + k, w - r + k, h, w - r, h),
      P.lineTo(r, h), P.appendBezierCurve(r - k, h, 0, h - r + k, 0, h - r),
      P.lineTo(0, r), P.appendBezierCurve(0, r - k, r - k, 0, r, 0), P.closePath()];
  }
  function point(matrix, x, y) {
    return [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]];
  }
  function addLink(state, page, url, matrix, x, y, w, h) {
    const uri = safeURL(url); if (!uri || w <= 0 || h <= 0) return;
    const pts = [point(matrix, x, y), point(matrix, x + w, y), point(matrix, x, y + h), point(matrix, x + w, y + h)];
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
    const rect = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    const annotation = state.doc.context.obj({
      Type: 'Annot', Subtype: 'Link', Rect: rect, Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: state.P.PDFString.of(uri) }
    });
    page.node.addAnnot(state.doc.context.register(annotation));
  }
  function warn(state, code, message, elementId) {
    const key = code + ':' + (elementId || message);
    if (!state.warningKeys.has(key)) { state.warningKeys.add(key); state.warnings.push({ code, message, elementId: elementId || null }); }
  }
  async function loadImage(state, id) {
    if (state.images.has(id)) return state.images.get(id);
    const asset = state.assets[id];
    if (!asset || !asset.src) throw err('Missing image asset: ' + id);
    const data = await assetBytes(asset.src);
    const mime = /^data:([^;,]+)/i.exec(asset.src)?.[1] || 'application/octet-stream';
    const blobURL = URL.createObjectURL(new Blob([data], { type: mime }));
    let img;
    try {
      img = await new Promise((resolve, reject) => {
        const image = new Image();
        const timeout = setTimeout(() => reject(err('Image decoding timed out: ' + (asset.name || id))), 20000);
        image.onload = () => { clearTimeout(timeout); resolve(image); };
        image.onerror = () => { clearTimeout(timeout); reject(err('Cannot decode image: ' + (asset.name || id))); };
        image.src = blobURL;
      });
    } finally { URL.revokeObjectURL(blobURL); }
    let embedded;
    if (/image\/jpe?g/i.test(mime)) embedded = await state.doc.embedJpg(data);
    else if (/image\/png/i.test(mime)) embedded = await state.doc.embedPng(data);
    else {
      const c = makeCanvas(img.naturalWidth, img.naturalHeight, 1);
      c.ctx.drawImage(img, 0, 0, c.width, c.height);
      embedded = await state.doc.embedPng(canvasBytes(c.canvas));
      if (/gif/i.test(mime)) warn(state, 'static-gif', 'Animated GIFs are exported as a single static frame.', id);
    }
    const result = { image: img, pdf: embedded, width: img.naturalWidth, height: img.naturalHeight };
    state.images.set(id, result); return result;
  }
  function imageLayout(el, image, w, h) {
    const crop = el.fit === 'cover' ? el.crop || {} : {};
    const cx = clamp(num(crop.x, 0), 0, 1), cy = clamp(num(crop.y, 0), 0, 1);
    const cw = clamp(num(crop.w, 1), 0.00001, Math.max(0.00001, 1 - cx));
    const ch = clamp(num(crop.h, 1), 0.00001, Math.max(0.00001, 1 - cy));
    if (cx >= 1 || cy >= 1) throw err('Image crop falls outside the image: ' + (el.id || 'unknown'));
    const sourceW = image.width * cw, sourceH = image.height * ch;
    const fit = el.fit || 'contain';
    let scaleX, scaleY;
    if (fit === 'fill') { scaleX = w / sourceW; scaleY = h / sourceH; }
    else { scaleX = scaleY = (fit === 'contain' ? Math.min : Math.max)(w / sourceW, h / sourceH); }
    const dx = (w - sourceW * scaleX) * clamp(num(el.positionX, .5), 0, 1);
    const dy = (h - sourceH * scaleY) * clamp(num(el.positionY, .5), 0, 1);
    return { sx: cx * image.width, sy: cy * image.height, sw: sourceW, sh: sourceH,
      dx, dy, dw: sourceW * scaleX, dh: sourceH * scaleY, scaleX, scaleY };
  }
  function filterOf(effect) {
    if (!effect) return '';
    if (typeof effect === 'string') return /^(none|fade|rise|zoom|float|pulse)$/.test(effect) ? '' : effect;
    if (effect.filter) return String(effect.filter);
    const values = [];
    for (const name of ['grayscale', 'sepia', 'brightness', 'contrast', 'saturate', 'opacity']) {
      if (effect[name] != null) values.push(name + '(' + effect[name] + ')');
    }
    if (effect.saturation != null) values.push('saturate(' + effect.saturation + ')');
    if (effect.blur != null) values.push('blur(' + num(effect.blur, 0) + 'px)');
    if (effect.hueRotate != null) values.push('hue-rotate(' + num(effect.hueRotate, 0) + 'deg)');
    if (effect.dropShadow) values.push('drop-shadow(' + effect.dropShadow + ')');
    return values.join(' ');
  }
  function hasEffect(effect) { return !!(filterOf(effect) || (typeof effect === 'object' && effect?.shadow)); }
  function applyEffect(ctx, effect) {
    const filter = filterOf(effect); if (filter) ctx.filter = filter;
    const s = typeof effect === 'object' && effect.shadow;
    if (s && typeof s === 'object') {
      ctx.shadowColor = s.color || '#00000066'; ctx.shadowBlur = num(s.blur, 0);
      ctx.shadowOffsetX = num(s.x, 0); ctx.shadowOffsetY = num(s.y, 0);
    }
  }
  async function drawImage(state, page, el, g, assetId) {
    const img = await loadImage(state, assetId); const l = imageLayout(el, img, g.w, g.h);
    if (hasEffect(el.effect)) {
      const c = makeCanvas(g.w, g.h, 3); applyEffect(c.ctx, el.effect);
      c.ctx.drawImage(img.image, l.sx, l.sy, l.sw, l.sh, l.dx, l.dy, l.dw, l.dh);
      const embedded = await state.doc.embedPng(canvasBytes(c.canvas));
      page.drawImage(embedded, { x: 0, y: 0, width: g.w, height: g.h, opacity: clamp(num(el.opacity, 1), 0, 1) });
    } else {
      // Clip to the selected source crop, then draw the original image at full resolution.
      const left = Math.max(0, l.dx), top = Math.max(0, l.dy);
      const right = Math.min(g.w, l.dx + l.dw), bottom = Math.min(g.h, l.dy + l.dh);
      page.pushOperators(state.P.pushGraphicsState(), state.P.rectangle(left, g.h - bottom, Math.max(0, right - left), Math.max(0, bottom - top)), state.P.clip(), state.P.endPath());
      const fullW = img.width * l.scaleX, fullH = img.height * l.scaleY;
      page.drawImage(img.pdf, { x: l.dx - l.sx * l.scaleX,
        y: g.h - (l.dy - l.sy * l.scaleY) - fullH, width: fullW, height: fullH,
        opacity: clamp(num(el.opacity, 1), 0, 1) });
      page.pushOperators(state.P.popGraphicsState());
    }
  }
  function fontEntry(state, alias, bold, italic) {
    let entry = state.project.fonts?.[alias];
    if (typeof entry === 'string') entry = { assetId: entry };
    const isSans = /(sans|futura|condensed|helvetica|arial)/i.test(alias);
    const defaultInfo = FONT_DEFAULTS[alias] || [isSans ? 'Helvetica' : 'Times-Roman', isSans ? 'sans-serif' : 'serif', 'normal', 'normal'];
    const requested = { alias, entry, standard: defaultInfo[0], family: entry?.family || defaultInfo[1],
      weight: bold ? 'bold' : (entry?.weight || defaultInfo[2]), style: italic ? 'italic' : (entry?.style || defaultInfo[3]) };
    if (bold || italic) {
      const weight = /bold|[6-9]00/.test(String(requested.weight)); const ital = requested.style === 'italic';
      const siblings = Object.entries(state.project.fonts || {}).filter(([, e]) => e.family === requested.family);
      const sibling = siblings.find(([, e]) => /bold|[6-9]00/.test(String(e.weight || 'normal')) === weight && (e.style === 'italic') === ital)
        || siblings.find(([, e]) => (e.style === 'italic') === ital);
      if (sibling) { requested.alias = sibling[0]; requested.entry = sibling[1]; }
      const sans = /^Helvetica/.test(defaultInfo[0]);
      requested.standard = sans ? (weight ? (ital ? 'Helvetica-BoldOblique' : 'Helvetica-Bold') : (ital ? 'Helvetica-Oblique' : 'Helvetica'))
        : (weight ? (ital ? 'Times-BoldItalic' : 'Times-Bold') : (ital ? 'Times-Italic' : 'Times-Roman'));
    }
    return requested;
  }
  async function loadFont(state, alias, bold, italic) {
    const info = fontEntry(state, alias, bold, italic);
    const key = info.alias + ':' + info.weight + ':' + info.style;
    if (state.fonts.has(key)) return state.fonts.get(key);
    let pdf, family = info.family, raster = false;
    const asset = info.entry?.assetId ? state.assets[info.entry.assetId] : (info.entry?.src ? info.entry : null);
    if (info.entry?.assetId && !asset) throw err('Missing font asset: ' + info.entry.assetId);
    if (asset?.src) {
      const data = await assetBytes(asset.src); family = 'TLWCPdfFont' + state.fonts.size;
      const fontFace = new FontFace(family, data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength), { weight: String(info.entry.weight || info.weight), style: info.entry.style || info.style });
      try { await fontFace.load(); document.fonts.add(fontFace); state.loadedFaces.push(fontFace); }
      catch (e) { throw err('Cannot load local font: ' + (asset.name || alias), e); }
      if (state.hasFontkit) {
        try { pdf = await state.doc.embedFont(data, { subset: true }); }
        catch (e) { raster = true; warn(state, 'font-raster', 'The local font could not be embedded; its text is preserved as a high-resolution image.', alias); }
      } else {
        raster = true;
        warn(state, 'font-raster', 'Custom font text is preserved visually as a high-resolution image because the optional local fontkit bundle is not installed.', alias);
      }
    } else {
      pdf = await state.doc.embedFont(info.standard);
      if (FONT_DEFAULTS[alias] || alias !== 'Helvetica') warn(state, 'standard-font', 'No embedded font asset for ' + alias + '; using ' + info.standard + '.', alias);
    }
    const result = { ...info, family, pdf, raster, custom: !!asset };
    state.fonts.set(key, result); return result;
  }
  function richRuns(el) {
    if (!el.html) return [{ text: String(el.text || ''), bold: false, italic: false, link: null }];
    const doc = new DOMParser().parseFromString('<body>' + el.html + '</body>', 'text/html');
    const result = [];
    function visit(node, style) {
      if (node.nodeType === 3) { result.push({ ...style, text: node.nodeValue }); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName.toLowerCase();
      if (['script', 'style', 'iframe', 'object', 'img', 'video', 'audio'].includes(tag)) return;
      if (tag === 'br') { result.push({ ...style, text: '\n' }); return; }
      const next = { ...style, bold: style.bold || tag === 'b' || tag === 'strong', italic: style.italic || tag === 'i' || tag === 'em', underline: style.underline || tag === 'u' };
      if (tag === 'a') next.link = safeURL(node.getAttribute('href'));
      if ((tag === 'p' || tag === 'div') && result.length && !result[result.length - 1].text.endsWith('\n')) result.push({ ...style, text: '\n' });
      for (const child of node.childNodes) visit(child, next);
    }
    for (const child of doc.body.childNodes) visit(child, { bold: false, italic: false, link: null });
    return result;
  }
  function canvasFont(font, size) { return font.style + ' ' + font.weight + ' ' + size + 'px "' + font.family.replace(/"/g, '') + '"'; }
  function transliterate(value) {
    return String(value).replace(/[\u2010-\u2015\u2212]/g, '-').replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"').replace(/\u2026/g, '...').replace(/\u00a0/g, ' ')
      .replace(/\u202f/g, ' ').replace(/\u200b/g, '').replace(/\u2192/g, '->')
      .replace(/\u2190/g, '<-').replace(/\u2713/g, 'v').replace(/\u00ad/g, '');
  }
  async function textLayout(state, el, g) {
    const size = Math.max(1, num(el.fontSize, 14)), lineHeight = Math.max(1, num(el.lineHeight, size * 1.2));
    const spacing = num(el.letterSpacing, 0), alias = el.fontFamily || 'Sans';
    const measuring = makeCanvas(1, 1, 1).ctx;
    const lineWidth = values => values.reduce((s, item) => s + item.width, 0) + Math.max(0, values.length - 1) * spacing;
    async function characters(runs) {
      const chars = [];
      for (const run of runs) {
        const font = await loadFont(state, run.fontFamily || alias, !!run.bold || /bold|[6-9]00/.test(String(el.fontWeight || '')), !!run.italic || el.fontStyle === 'italic');
        const fontSize = Math.max(1, num(run.fontSize, size));
        let value = String(run.text || '').replace(/\r\n?/g, '\n').replace(/\t/g, '    ');
        if (!font.custom) {
          const old = value; value = transliterate(value);
          value = Array.from(value, ch => { if (ch === '\n') return ch; try { font.pdf.encodeText(ch); return ch; } catch (_) { return '?'; } }).join('');
          if (old !== value) warn(state, 'text-transliterated', 'Some punctuation or unsupported characters were transliterated for a standard PDF font. Embed the original font to preserve all characters.', el.id);
        }
        measuring.font = canvasFont(font, fontSize); measuring.fontKerning = 'none';
        const rawLink = run.link || (run.links || []).map(l => typeof l === 'string' ? l : l.href || l.url).find(Boolean);
        const link = safeURL(rawLink);
        for (const char of Array.from(value)) {
          const width = char === '\n' ? 0 : (font.pdf ? font.pdf.widthOfTextAtSize(char, fontSize) : measuring.measureText(char).width);
          chars.push({ char, font, size: fontSize, width, link, color: run.color || el.color || '#111111', underline: !!run.underline });
        }
      }
      return chars;
    }
    const lines = [];
    if (Array.isArray(el.sourceLines) && el.sourceLines.length) {
      for (let i = 0; i < el.sourceLines.length; i++) {
        const source = typeof el.sourceLines[i] === 'string' ? { text: el.sourceLines[i] } : el.sourceLines[i];
        const chars = (await characters(source.fragments?.length ? source.fragments : [{ text: source.text }])).filter(c => c.char !== '\n');
        lines.push({ chars, width: num(source.width, lineWidth(chars)), baseline: num(source.baseline, num(el.baselineOffset, size) + i * lineHeight) });
      }
    } else {
      const chars = await characters(richRuns(el)); let current = [], width = 0;
      const finish = explicit => {
        if (!explicit) while (current.length && /\s/.test(current[current.length - 1].char)) current.pop();
        lines.push({ chars: current, width: lineWidth(current) }); current = []; width = 0;
      };
      for (let i = 0; i < chars.length;) {
        if (chars[i].char === '\n') { finish(true); i++; continue; }
        let j = i + 1; const white = /\s/.test(chars[i].char);
        while (j < chars.length && chars[j].char !== '\n' && /\s/.test(chars[j].char) === white) j++;
        const word = chars.slice(i, j), wordWidth = lineWidth(word);
        if (!el.singleLine && !white && current.length && width + spacing + wordWidth > g.w + .01) finish(false);
        if (white && !current.length) { i = j; continue; }
        // Match CSS overflow-wrap:normal: a single long word may extend outside the frame.
        for (const ch of word) { current.push(ch); width = lineWidth(current); }
        i = j;
      }
      if (current.length || !lines.length || chars[chars.length - 1]?.char === '\n') finish(true);
    }
    const contentHeight = Math.max(lines.length * lineHeight, ...lines.map((l, i) => num(l.baseline, (i + 1) * lineHeight) + size * .3));
    if (contentHeight > g.h + size * .5) warn(state, 'text-overflow', 'Text extends outside its editable box, matching the visible HTML layout.', el.id);
    return { size, lineHeight, spacing, lines, contentHeight, raster: hasEffect(el.effect) || lines.some(l => l.chars.some(ch => ch.font.raster)) };
  }
  async function drawText(state, page, el, g) {
    const layout = await textLayout(state, el, g), opacity = clamp(num(el.opacity, 1), 0, 1);
    const maxSize = Math.max(layout.size, ...layout.lines.flatMap(l => l.chars.map(ch => ch.size)));
    const pad = Math.ceil(maxSize * .5 + num(el.effect?.shadow?.blur, 0));
    const lineX = line => el.textAlign === 'center' ? (g.w - line.width) / 2 : (el.textAlign === 'right' ? g.w - line.width : 0);
    const left = Math.min(0, ...layout.lines.map(lineX)) - pad;
    const right = Math.max(g.w, ...layout.lines.map(l => lineX(l) + l.width)) + pad;
    const canvas = layout.raster ? makeCanvas(right - left, Math.max(g.h, layout.contentHeight) + pad * 2, 3) : null;
    if (canvas) { canvas.ctx.translate(-left, pad); canvas.ctx.textBaseline = 'alphabetic'; canvas.ctx.fontKerning = 'none'; applyEffect(canvas.ctx, el.effect); }
    const colors = new Map();
    for (let lineIndex = 0; lineIndex < layout.lines.length; lineIndex++) {
      const line = layout.lines[lineIndex], top = lineIndex * layout.lineHeight;
      const align = el.textAlign || 'left';
      let x = align === 'center' ? (g.w - line.width) / 2 : (align === 'right' ? g.w - line.width : 0);
      const extra = align === 'justify' && lineIndex < layout.lines.length - 1
        ? Math.max(0, g.w - line.width) / (line.chars.filter(c => c.char === ' ').length || 1) : 0;
      const dominant = line.chars[0]?.font; let ascent = layout.size * .8, descent = layout.size * .2;
      if (dominant?.pdf) {
        try { ascent = dominant.pdf.heightAtSize(layout.size, { descender: false }); descent = dominant.pdf.heightAtSize(layout.size) - ascent; } catch (_) {}
      } else if (dominant) {
        canvas.ctx.font = canvasFont(dominant, layout.size); const metrics = canvas.ctx.measureText('Hg');
        ascent = metrics.fontBoundingBoxAscent || metrics.actualBoundingBoxAscent || ascent;
        descent = metrics.fontBoundingBoxDescent || metrics.actualBoundingBoxDescent || descent;
      }
      const normalBaseline = (layout.lineHeight - ascent - descent) / 2 + ascent;
      const baseline = line.baseline ?? (top + num(el.baselineOffset, normalBaseline));
      let linkStart = null, linkURL = null;
      const finishLink = () => {
        if (linkURL && linkStart != null) addLink(state, page, linkURL, g.matrix, linkStart, g.h - baseline - descent, x - linkStart, ascent + descent);
      };
      for (let index = 0; index < line.chars.length; index++) {
        const item = line.chars[index];
        if (item.link !== linkURL) { finishLink(); linkURL = item.link; linkStart = x; }
        if (canvas) {
          canvas.ctx.fillStyle = item.color; canvas.ctx.font = canvasFont(item.font, item.size); canvas.ctx.fillText(item.char, x, baseline);
          if (item.underline) { canvas.ctx.fillRect(x, baseline + item.size * .12, item.width + layout.spacing, Math.max(.5, item.size * .045)); }
        } else {
          let end = index + 1;
          while (end < line.chars.length && line.chars[end].font === item.font && line.chars[end].size === item.size && line.chars[end].color === item.color && line.chars[end].link === item.link && line.chars[end].underline === item.underline && !extra) end++;
          const segment = line.chars.slice(index, end);
          if (!colors.has(item.color)) colors.set(item.color, color(item.color, state.P));
          const fill = colors.get(item.color);
          if (fill) {
            try {
              page.pushOperators(state.P.pushGraphicsState(), state.P.setCharacterSpacing(layout.spacing));
              page.drawText(segment.map(ch => ch.char).join(''), { x, y: g.h - baseline, size: item.size, font: item.font.pdf, color: fill.color, opacity: opacity * fill.alpha });
              page.pushOperators(state.P.popGraphicsState());
              if (item.underline) page.drawLine({ start: { x, y: g.h - baseline - item.size * .12 }, end: { x: x + segment.reduce((s, ch) => s + ch.width, 0) + Math.max(0, segment.length - 1) * layout.spacing, y: g.h - baseline - item.size * .12 }, thickness: Math.max(.5, item.size * .045), color: fill.color, opacity: opacity * fill.alpha });
            }
            catch (e) { throw err('Cannot encode text in element ' + (el.id || '') + '. Embed a font supporting these characters.', e); }
          }
          x += segment.slice(1).reduce((total, ch) => total + ch.width + layout.spacing + (ch.char === ' ' ? extra : 0), 0);
          index = end - 1;
        }
        x += item.width + layout.spacing + (item.char === ' ' ? extra : 0);
      }
      if (line.chars.length) x -= layout.spacing;
      finishLink();
    }
    if (canvas) {
      const image = await state.doc.embedPng(canvasBytes(canvas.canvas));
      page.drawImage(image, { x: left, y: g.h - canvas.height + pad, width: canvas.width, height: canvas.height, opacity });
    }
  }
  async function drawShape(state, page, el, g) {
    const fill = color(el.fill, state.P), border = color(el.borderColor, state.P);
    const opacity = clamp(num(el.opacity, 1), 0, 1), borderWidth = Math.max(0, num(el.borderWidth, 0));
    if (hasEffect(el.effect)) {
      const c = makeCanvas(g.w, g.h, 3); applyEffect(c.ctx, el.effect);
      c.ctx.beginPath();
      if (el.shape === 'ellipse' || el.shape === 'circle') c.ctx.ellipse(g.w / 2, g.h / 2, Math.max(0, (g.w - borderWidth) / 2), Math.max(0, (g.h - borderWidth) / 2), 0, 0, Math.PI * 2);
      else c.ctx.rect(borderWidth / 2, borderWidth / 2, Math.max(0, g.w - borderWidth), Math.max(0, g.h - borderWidth));
      if (fill) { c.ctx.fillStyle = el.fill; c.ctx.fill(); }
      if (border && borderWidth) { c.ctx.strokeStyle = el.borderColor; c.ctx.lineWidth = borderWidth; c.ctx.stroke(); }
      page.drawImage(await state.doc.embedPng(canvasBytes(c.canvas)), { x: 0, y: 0, width: g.w, height: g.h, opacity });
      return;
    }
    const options = { ...(fill ? { color: fill.color, opacity: opacity * fill.alpha } : { opacity: 0 }),
      ...(border && borderWidth ? { borderColor: border.color, borderWidth, borderOpacity: opacity * border.alpha } : { borderWidth: 0 }) };
    const inset = border && borderWidth ? borderWidth / 2 : 0;
    if (el.shape === 'ellipse' || el.shape === 'circle') page.drawEllipse({ x: g.w / 2, y: g.h / 2, xScale: Math.max(.01, g.w / 2 - inset), yScale: Math.max(.01, g.h / 2 - inset), ...options });
    else if (num(el.borderRadius, 0) > 0) {
      const w = Math.max(.01, g.w - inset * 2), h = Math.max(.01, g.h - inset * 2), r = clamp(num(el.borderRadius, 0) - inset, 0, Math.min(w, h) / 2);
      const path = 'M ' + r + ' 0 H ' + (w - r) + ' Q ' + w + ' 0 ' + w + ' ' + r + ' V ' + (h - r) + ' Q ' + w + ' ' + h + ' ' + (w - r) + ' ' + h + ' H ' + r + ' Q 0 ' + h + ' 0 ' + (h - r) + ' V ' + r + ' Q 0 0 ' + r + ' 0 Z';
      page.drawSvgPath(path, { x: inset, y: g.h - inset, ...options });
    } else page.drawRectangle({ x: inset, y: inset, width: Math.max(.01, g.w - inset * 2), height: Math.max(.01, g.h - inset * 2), ...options });
  }
  async function drawVideo(state, page, el, g) {
    if (el.posterAssetId) await drawImage(state, page, { ...el, assetId: el.posterAssetId }, g, el.posterAssetId);
    else {
      page.drawRectangle({ x: 0, y: 0, width: g.w, height: g.h, color: state.P.rgb(.06, .07, .09), opacity: clamp(num(el.opacity, 1), 0, 1) });
      const font = await state.doc.embedFont('Helvetica');
      const label = 'VIDEO'; const size = Math.min(18, g.w / 7, g.h / 5);
      page.drawText(label, { x: (g.w - font.widthOfTextAtSize(label, size)) / 2, y: g.h / 2 - size / 2, size, font, color: state.P.rgb(1, 1, 1), opacity: clamp(num(el.opacity, 1), 0, 1) });
      warn(state, 'video-no-poster', 'A video has no poster; a labelled static panel was exported.', el.id);
    }
    const link = safeURL(el.link) || safeURL(el.src);
    if (link) addLink(state, page, link, g.matrix, 0, 0, g.w, g.h);
    warn(state, 'static-video', link ? 'Video exported as a static poster with a clickable link.' : 'Local video exported as a static poster; the media stays playable in the editable HTML, not this PDF.', el.id);
  }
  function splitCSSArgs(value) {
    let depth = 0, chunk = '', out = [];
    for (const ch of value) { if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { out.push(chunk.trim()); chunk = ''; } else chunk += ch; }
    if (chunk) out.push(chunk.trim()); return out;
  }
  async function background(state, page, source, width, height) {
    const fill = color(source.background || '#ffffff', state.P);
    if (fill) page.drawRectangle({ x: 0, y: 0, width, height, color: fill.color, opacity: fill.alpha });
    if (source.backgroundGradient) {
      const match = /^(linear|radial)-gradient\((.*)\)$/s.exec(String(source.backgroundGradient).trim());
      if (!match) throw err('Unsupported page gradient. Use a CSS linear-gradient or radial-gradient.');
      const c = makeCanvas(width, height, 2), args = splitCSSArgs(match[2]); let gradient;
      if (match[1] === 'linear') {
        let degrees = 180;
        if (/^(to\s|[-\d.]+(?:deg|rad|turn))/.test(args[0])) {
          const angle = args.shift();
          if (/deg$/.test(angle)) degrees = parseFloat(angle);
          else if (/rad$/.test(angle)) degrees = parseFloat(angle) * 180 / Math.PI;
          else if (/turn$/.test(angle)) degrees = parseFloat(angle) * 360;
          else {
            const right = /right/.test(angle), left = /left/.test(angle), top = /top/.test(angle), bottom = /bottom/.test(angle);
            degrees = Math.atan2((right ? 1 : 0) - (left ? 1 : 0), (top ? 1 : 0) - (bottom ? 1 : 0)) * 180 / Math.PI;
          }
        }
        const rad = degrees * Math.PI / 180, vx = Math.sin(rad), vy = -Math.cos(rad);
        const half = (Math.abs(vx) * width + Math.abs(vy) * height) / 2;
        gradient = c.ctx.createLinearGradient(width / 2 - vx * half, height / 2 - vy * half, width / 2 + vx * half, height / 2 + vy * half);
      } else {
        if (/^(circle|ellipse|at\s)/.test(args[0])) args.shift();
        gradient = c.ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.hypot(width, height) / 2);
      }
      const stops = args.map(value => { const m = /^(.*?)\s+([-\d.]+)%$/.exec(value); return { value: m ? m[1] : value, offset: m ? clamp(parseFloat(m[2]) / 100, 0, 1) : null }; });
      if (stops.length < 2) throw err('A page gradient needs at least two colour stops.');
      if (stops[0].offset == null) stops[0].offset = 0;
      if (stops[stops.length - 1].offset == null) stops[stops.length - 1].offset = 1;
      for (let i = 1; i < stops.length; i++) {
        if (stops[i].offset == null) {
          let end = i; while (stops[end].offset == null) end++;
          const start = i - 1; for (let j = i; j < end; j++) stops[j].offset = stops[start].offset + (stops[end].offset - stops[start].offset) * (j - start) / (end - start);
          i = end;
        }
      }
      for (const stop of stops) gradient.addColorStop(stop.offset, stop.value);
      c.ctx.fillStyle = gradient; c.ctx.fillRect(0, 0, width, height);
      page.drawImage(await state.doc.embedPng(canvasBytes(c.canvas)), { x: 0, y: 0, width, height });
    }
    if (source.backgroundImageId) await drawImage(state, page, { fit: source.backgroundFit || 'contain', positionX: source.backgroundPositionX ?? .5, positionY: source.backgroundPositionY ?? .5, crop: source.backgroundCrop, opacity: 1 }, { w: width, h: height }, source.backgroundImageId);
  }
  async function generate(project, onProgress) {
    const P = global.PDFLib;
    if (!P?.PDFDocument) throw err('The local PDF library has not loaded. Reload the editor before exporting.');
    if (!project || !Array.isArray(project.pages) || !project.pages.length) throw err('Add at least one page before exporting.');
    // Work on a shallow copy so hidden drafts remain intact in the editable project.
    project = { ...project, pages: project.pages.filter(page => page.hidden !== true) };
    if (!project.pages.length) throw err('No published pages. Make at least one draft page visible before exporting.');
    const width = num(project.width, 630), height = num(project.height, 840);
    if (!(width > 0 && height > 0 && width <= 20000 && height <= 20000)) throw err('Invalid page dimensions.');
    const doc = await P.PDFDocument.create();
    const hasFontkit = !!global.fontkit; if (hasFontkit) doc.registerFontkit(global.fontkit);
    const state = { P, doc, project, assets: assetsOf(project), fonts: new Map(), images: new Map(), loadedFaces: [], warnings: [], warningKeys: new Set(), hasFontkit };
    const progress = event => { if (typeof onProgress === 'function') onProgress({ totalPages: project.pages.length, ...event }); };
    try {
      doc.setTitle(String(project.title || 'TLWC Magazine')); doc.setCreator('TLWC Magazine Editor'); doc.setProducer('TLWC Magazine Editor / pdf-lib');
      progress({ phase: 'preparing', page: 0, percent: 0, message: 'Preparing PDF' });
      for (let index = 0; index < project.pages.length; index++) {
        const source = project.pages[index], page = doc.addPage([width, height]);
        progress({ phase: 'page', page: index + 1, percent: Math.round(index / project.pages.length * 90), message: 'Rendering page ' + (index + 1) });
        try {
          await background(state, page, source, width, height);
          const elements = (source.elements || []).map((el, i) => ({ el, i })).sort((a, b) => num(a.el.z, a.i) - num(b.el.z, b.i));
          for (const { el } of elements) {
            if (el.hidden || num(el.opacity, 1) <= 0) continue;
            const g = geometry(el, height);
            if ((el.type !== 'line' && (g.w <= 0 || g.h <= 0)) || (g.w <= 0 && g.h <= 0)) continue;
            page.pushOperators(P.pushGraphicsState(), P.concatTransformationMatrix(...g.matrix));
            // Text may overflow its editable frame, as in the shared HTML renderer.
            if (el.type === 'image' || el.type === 'video') page.pushOperators(...framePath(P, g.w, g.h, el.borderRadius, el.frameShape), P.clip(), P.endPath());
            if (typeof el.effect === 'string' && /^(fade|rise|zoom|float|pulse)$/.test(el.effect)) warn(state, 'static-animation', 'HTML animation exported in its neutral static state.', el.id);
            if (el.type === 'text') await drawText(state, page, el, g);
            else if (el.type === 'image') {
              if(el.isFrame&&!el.assetId)await drawShape(state,page,{...el,type:'shape',shape:el.frameShape==='ellipse'?'ellipse':'rect',fill:'#e5eff4'},g);else await drawImage(state, page, el, g, el.assetId);
              if (num(el.borderWidth, 0) > 0 && el.borderColor) await drawShape(state, page, { ...el, type: 'shape', shape: el.frameShape==='ellipse'?'ellipse':'rect', fill: null, effect: null }, g);
            }
            else if (el.type === 'shape') await drawShape(state, page, el, g);
            else if (el.type === 'line') {
              const fill = color(el.color || el.lineColor || '#000000', P);
              if (fill) page.drawLine({ start: { x: 0, y: g.h }, end: { x: g.w, y: 0 }, thickness: Math.max(.01, num(el.lineWidth, 1)), color: fill.color, opacity: clamp(num(el.opacity, 1), 0, 1) * fill.alpha });
            } else if (el.type === 'video') {await drawVideo(state, page, el, g);if(num(el.borderWidth,0)>0)await drawShape(state,page,{...el,type:'shape',shape:el.frameShape==='ellipse'?'ellipse':'rect',fill:null,effect:null},g);}
            else warn(state, 'unknown-element', 'Unsupported element type skipped: ' + el.type, el.id);
            page.pushOperators(P.popGraphicsState());
            if (el.type !== 'video') addLink(state, page, el.link, g.matrix, 0, 0, g.w, g.h);
          }
        } catch (e) { throw err('PDF export failed on page ' + (index + 1) + ' (' + (source.name || source.id || 'untitled') + '): ' + e.message, e); }
        await yieldFrame();
      }
      progress({ phase: 'saving', page: project.pages.length, percent: 95, message: 'Building PDF file' });
      const bytes = await doc.save();
      const fileName = (String(project.title || 'TLWC Magazine').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').trim() || 'TLWC Magazine') + '.pdf';
      return { bytes, fileName, pageCount: project.pages.length, warnings: state.warnings };
    } finally { for (const face of state.loadedFaces) document.fonts.delete(face); }
  }
  async function exportPDF(project, onProgress) {
    const result = await generate(project, onProgress);
    const blob = new Blob([result.bytes], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = result.fileName; link.style.display = 'none';
    document.body.appendChild(link);
    try { link.click(); } finally { link.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); }
    if (typeof onProgress === 'function') onProgress({ phase: 'download-requested', page: result.pageCount, totalPages: result.pageCount, percent: 100, message: 'PDF download requested', warnings: result.warnings });
    // Browser download completion is controlled by the user agent, not observable here.
    return { fileName: result.fileName, pageCount: result.pageCount, byteLength: result.bytes.length, warnings: result.warnings, downloadRequested: true };
  }
  global.TLWCPdf = Object.freeze({ version: VERSION, export: exportPDF, generate });
})(typeof window !== 'undefined' ? window : globalThis);
