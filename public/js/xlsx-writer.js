/* ============================================================
 * XlsxWriter — pembuat file .xlsx mandiri (tanpa pustaka)
 * Menghasilkan XLSX lengkap: beberapa sheet, judul digabung,
 * lebar kolom, tinggi baris, garis sel, warna header & baris
 * selang-seling, perataan teks. Format ZIP (metode STORE).
 *
 * Dipakai: unduh XLSX detail kampung.
 * API:
 *   XlsxWriter.save(book, namaFile)
 *   book = {
 *     title:   string,               // judul dokumen (opsional)
 *     creator: string,               // pembuat (opsional)
 *     sheets:  [ {
 *       name:       string,          // nama sheet (maks 31 huruf)
 *       colWidths:  [5, 20, ...],    // lebar kolom (satuan huruf)
 *       rowHeights: {0: 20, 4: 32},  // tinggi baris (pt) per indeks
 *       merges:     ['A1:I1', ...],  // sel yang digabung
 *       cells:      [[{...}, ...], ...]  // baris → sel
 *     } ]
 *   }
 *   Sel: { v: nilai, bold, italic, sz, color, fill, align, wrap, border }
 *     v      : string | number   (string → teks, number → angka)
 *     color/fill : 'RRGGBB'      (fill = warna latar sel)
 *     align  : 'left' | 'center' | 'right'
 *     wrap   : true → teks membungkus
 *     border : true → garis tipis di 4 sisi
 * ============================================================ */
(function (global) {
  'use strict';

  var enc = new TextEncoder();

  /* --- XML ---------------------------------------------------- */
  function xmlEscape(s) {
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }

  /* Alamat sel: indeks baris/kolom berbasis 0 → "A1", "I12", dst. */
  function cellRef(row, col) {
    var s = '';
    var c = col + 1;
    while (c > 0) {
      var m = (c - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      c = Math.floor((c - 1) / 26);
    }
    return s + (row + 1);
  }

  /* --- CRC32 (untuk ZIP) -------------------------------------- */
  var CRC_TABLE = null;
  function crc32(bytes) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Uint32Array(256);
      for (var n = 0; n < 256; n++) {
        var c = n;
        for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
        CRC_TABLE[n] = c >>> 0;
      }
    }
    var crc = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }

  /* --- Tabel gaya: kumpulan font/fill/border/xf yang dipakai --- */
  function StyleTable() {
    this.fonts = [{ sz: 11, color: null, bold: false, italic: false }]; // 0 = bawaan
    this.fills = [null, 'GRAY125'];                                     // 0 = none, 1 = gray125
    this.borders = [false, true];                                       // 0 = none, 1 = tipis
    this.xfs = [];
    this._fontIdx = {};
    this._fillIdx = {};
    this._xfIdx = {};
  }
  StyleTable.prototype.xfIndex = function (cell) {
    var fontKey = (cell.bold ? 1 : 0) + '|' + (cell.italic ? 1 : 0) + '|' + (cell.sz || 11) + '|' + (cell.color || '');
    var fontId = this._fontIdx[fontKey];
    if (fontId == null) {
      fontId = this.fonts.length;
      this.fonts.push({ sz: cell.sz || 11, color: cell.color || null, bold: !!cell.bold, italic: !!cell.italic });
      this._fontIdx[fontKey] = fontId;
    }
    var fillId = 0;
    if (cell.fill) {
      fillId = this._fillIdx[cell.fill];
      if (fillId == null) {
        fillId = this.fills.push(cell.fill) - 1;
        this._fillIdx[cell.fill] = fillId;
      }
    }
    var borderId = cell.border ? 1 : 0;
    var align = cell.align || 'left';
    var wrap = !!cell.wrap;
    var xfKey = fontId + '|' + fillId + '|' + borderId + '|' + align + '|' + (wrap ? 1 : 0);
    var idx = this._xfIdx[xfKey];
    if (idx == null) {
      idx = this.xfs.length;
      this.xfs.push({ fontId: fontId, fillId: fillId, borderId: borderId, align: align, wrap: wrap });
      this._xfIdx[xfKey] = idx;
    }
    return idx;
  };

  /* --- styles.xml --------------------------------------------- */
  function stylesXml(st) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    xml += '<fonts count="' + st.fonts.length + '">' + st.fonts.map(function (f) {
      return '<font><sz val="' + f.sz + '"/>' +
        (f.color ? '<color rgb="FF' + f.color + '"/>' : '') +
        '<name val="Calibri"/>' +
        (f.bold ? '<b/>' : '') + (f.italic ? '<i/>' : '') + '</font>';
    }).join('') + '</fonts>';
    xml += '<fills count="' + st.fills.length + '">' + st.fills.map(function (f) {
      if (f === null) return '<fill><patternFill patternType="none"/></fill>';
      if (f === 'GRAY125') return '<fill><patternFill patternType="gray125"/></fill>';
      return '<fill><patternFill patternType="solid"><fgColor rgb="FF' + f + '"/><bgColor rgb="FF' + f + '"/></patternFill></fill>';
    }).join('') + '</fills>';
    xml += '<borders count="' + st.borders.length + '">' + st.borders.map(function (b) {
      return b
        ? '<border><left style="thin"><color rgb="FF94A3B8"/></left><right style="thin"><color rgb="FF94A3B8"/></right>' +
          '<top style="thin"><color rgb="FF94A3B8"/></top><bottom style="thin"><color rgb="FF94A3B8"/></bottom></border>'
        : '<border><left/><right/><top/><bottom/></border>';
    }).join('') + '</borders>';
    xml += '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>';
    xml += '<cellXfs count="' + st.xfs.length + '">' + st.xfs.map(function (x) {
      return '<xf numFmtId="0" fontId="' + x.fontId + '" fillId="' + x.fillId + '" borderId="' + x.borderId +
        '" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1">' +
        '<alignment horizontal="' + x.align + '" vertical="center"' + (x.wrap ? ' wrapText="1"' : '') + '/></xf>';
    }).join('') + '</cellXfs>';
    xml += '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>';
    xml += '</styleSheet>';
    return xml;
  }

  /* --- worksheet XML ------------------------------------------ */
  function sheetXml(sh, st) {
    var lastRow = sh.cells.length - 1;
    var lastCol = 0;
    sh.cells.forEach(function (row) { lastCol = Math.max(lastCol, row.length - 1); });
    var lastRef = cellRef(Math.max(lastRow, 0), Math.max(lastCol, 0));

    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">';
    xml += '<dimension ref="A1:' + lastRef + '"/>';
    xml += '<sheetViews><sheetView workbookViewId="0"/></sheetViews>';
    xml += '<sheetFormatPr defaultRowHeight="15"/>';
    xml += '<cols>' + sh.colWidths.map(function (w, i) {
      return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>';
    }).join('') + '</cols>';

    xml += '<sheetData>';
    sh.cells.forEach(function (row, ri) {
      var rh = sh.rowHeights && sh.rowHeights[ri] ? ' ht="' + sh.rowHeights[ri] + '" customHeight="1"' : '';
      xml += '<row r="' + (ri + 1) + '"' + rh + '>';
      row.forEach(function (cell, ci) {
        if (!cell) return;
        var ref = cellRef(ri, ci);
        var sIdx = st.xfIndex(cell);
        if (typeof cell.v === 'number') {
          xml += '<c r="' + ref + '" s="' + sIdx + '"><v>' + cell.v + '</v></c>';
        } else {
          xml += '<c r="' + ref + '" s="' + sIdx + '" t="inlineStr"><is><t xml:space="preserve">' +
            xmlEscape(cell.v) + '</t></is></c>';
        }
      });
      xml += '</row>';
    });
    xml += '</sheetData>';

    if (sh.merges && sh.merges.length) {
      xml += '<mergeCells count="' + sh.merges.length + '">' +
        sh.merges.map(function (m) { return '<mergeCell ref="' + m + '"/>'; }).join('') + '</mergeCells>';
    }
    xml += '</worksheet>';
    return xml;
  }

  /* --- workbook.xml & relasi ---------------------------------- */
  function workbookXml(book, sheetNames) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">';
    xml += '<fileVersion appName="SuaraPendukung"/><workbookPr/>';
    xml += '<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="25600" windowHeight="16000"/></bookViews>';
    xml += '<sheets>' + sheetNames.map(function (n, i) {
      return '<sheet name="' + xmlEscape(n) + '" sheetId="' + (i + 1) + '" r:id="rId' + (i + 1) + '"/>';
    }).join('') + '</sheets>';
    xml += '<calcPr calcId="122211"/></workbook>';
    return xml;
  }

  function workbookRelsXml(count) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">';
    for (var i = 1; i <= count; i++) {
      xml += '<Relationship Id="rId' + i + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + i + '.xml"/>';
    }
    xml += '<Relationship Id="rId' + (count + 1) + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';
    xml += '</Relationships>';
    return xml;
  }

  var ROOT_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
    '</Relationships>';

  function contentTypesXml(count) {
    var xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>';
    for (var i = 1; i <= count; i++) {
      xml += '<Override PartName="/xl/worksheets/sheet' + i + '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>';
    }
    xml += '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '</Types>';
    return xml;
  }

  function coreXml(book) {
    var now = new Date().toISOString();
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
      '<coreProperties xmlns="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ' +
      'xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ' +
      'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      (book.title ? '<dc:title>' + xmlEscape(book.title) + '</dc:title>' : '') +
      '<dc:creator>' + xmlEscape(book.creator || 'Suara Pendukung') + '</dc:creator>' +
      '<dcterms:created xsi:type="dcterms:W3CDTF">' + now + '</dcterms:created>' +
      '<dcterms:modified xsi:type="dcterms:W3CDTF">' + now + '</dcterms:modified>' +
      '</coreProperties>';
  }

  var APP_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n' +
    '<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ' +
    'xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">' +
    '<Application>Suara Pendukung</Application><DocSecurity>0</DocSecurity>' +
    '<ScaleCrop>false</ScaleCrop><Company>Suara Pendukung</Company>' +
    '<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc>' +
    '<HyperlinksChanged>false</HyperlinksChanged>' +
    '</Properties>';

  /* --- ZIP (metode STORE, tanpa kompresi) --------------------- */
  function zipStore(files) {
    var now = new Date();
    var dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    var dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    var chunks = [];
    var central = [];
    var offset = 0;

    files.forEach(function (f) {
      var nameBytes = enc.encode(f.name);
      var crc = crc32(f.data);
      var size = f.data.length;
      var lh = new DataView(new ArrayBuffer(30));
      lh.setUint32(0, 0x04034b50, true);
      lh.setUint16(4, 20, true);
      lh.setUint16(6, 0x0800, true);   // bendera: nama UTF-8
      lh.setUint16(8, 0, true);        // metode: STORE
      lh.setUint16(10, dosTime, true);
      lh.setUint16(12, dosDate, true);
      lh.setUint32(14, crc, true);
      lh.setUint32(18, size, true);
      lh.setUint32(22, size, true);
      lh.setUint16(26, nameBytes.length, true);
      lh.setUint16(28, 0, true);
      chunks.push(new Uint8Array(lh.buffer), nameBytes, f.data);
      central.push({ nameBytes: nameBytes, crc: crc, size: size, offset: offset });
      offset += 30 + nameBytes.length + size;
    });

    var centralChunks = [];
    var centralSize = 0;
    central.forEach(function (c) {
      var ch = new DataView(new ArrayBuffer(46));
      ch.setUint32(0, 0x02014b50, true);
      ch.setUint16(4, 20, true);
      ch.setUint16(6, 20, true);
      ch.setUint16(8, 0x0800, true);
      ch.setUint16(10, 0, true);
      ch.setUint16(12, dosTime, true);
      ch.setUint16(14, dosDate, true);
      ch.setUint32(16, c.crc, true);
      ch.setUint32(20, c.size, true);
      ch.setUint32(24, c.size, true);
      ch.setUint16(28, c.nameBytes.length, true);
      ch.setUint16(30, 0, true);
      ch.setUint16(32, 0, true);
      ch.setUint16(34, 0, true);
      ch.setUint16(36, 0, true);
      ch.setUint32(38, 0, true);
      ch.setUint32(42, c.offset, true);
      centralChunks.push(new Uint8Array(ch.buffer), c.nameBytes);
      centralSize += 46 + c.nameBytes.length;
    });

    var eocd = new DataView(new ArrayBuffer(22));
    eocd.setUint32(0, 0x06054b50, true);
    eocd.setUint16(4, 0, true);
    eocd.setUint16(6, 0, true);
    eocd.setUint16(8, files.length, true);
    eocd.setUint16(10, files.length, true);
    eocd.setUint32(12, centralSize, true);
    eocd.setUint32(16, offset, true);
    eocd.setUint16(20, 0, true);

    var all = chunks.concat(centralChunks, [new Uint8Array(eocd.buffer)]);
    var total = 0;
    all.forEach(function (b) { total += b.length; });
    var out = new Uint8Array(total);
    var p = 0;
    all.forEach(function (b) { out.set(b, p); p += b.length; });
    return out;
  }

  /* --- API publik --------------------------------------------- */
  function save(book, filename) {
    if (!book || !book.sheets || !book.sheets.length) throw new Error('Tidak ada sheet');

    var st = new StyleTable();
    var sheetNames = book.sheets.map(function (s) { return s.name; });

    // Proses sheet DULU (memakai sekaligus mengisi tabel gaya),
    // baru susun styles.xml — sebab isi styles.xml bergantung pada gaya yang dipakai.
    var sheetXmls = book.sheets.map(function (sh) {
      return enc.encode(sheetXml(sh, st));
    });

    var files = [];
    files.push({ name: '[Content_Types].xml', data: enc.encode(contentTypesXml(book.sheets.length)) });
    files.push({ name: '_rels/.rels', data: enc.encode(ROOT_RELS) });
    files.push({ name: 'docProps/app.xml', data: enc.encode(APP_XML) });
    files.push({ name: 'docProps/core.xml', data: enc.encode(coreXml(book)) });
    files.push({ name: 'xl/workbook.xml', data: enc.encode(workbookXml(book, sheetNames)) });
    files.push({ name: 'xl/_rels/workbook.xml.rels', data: enc.encode(workbookRelsXml(book.sheets.length)) });
    files.push({ name: 'xl/styles.xml', data: enc.encode(stylesXml(st)) });
    sheetXmls.forEach(function (data, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: data });
    });

    var zip = zipStore(files);
    var blob = new Blob([zip], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename || 'data.xlsx';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 0);
  }

  global.XlsxWriter = { save: save };
})(window);
