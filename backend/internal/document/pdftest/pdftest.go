// Package pdftest собирает синтетические PDF для тестов: с текстовым
// слоем по-русски, как у счёта из учётной системы, и без него, как у скана.
//
// Двоичных файлов в репозитории нет намеренно: документ строится из
// строк теста, и видно, что в нём лежит. Шрифт — Type0 с Identity-H и
// картой ToUnicode, как у PDF из Word, LibreOffice и 1С: кириллица в
// текстовом слое почти всегда хранится именно так. Глифов в файле нет —
// для извлечения текста они не нужны.
package pdftest

import (
	"bytes"
	"compress/zlib"
	"fmt"
	"strings"
)

// Build — PDF, где каждая страница — строки текста сверху вниз.
func Build(pages ...[]string) []byte {
	// Номера глифов (CID) раздаются символам по порядку появления.
	cids := map[rune]int{}
	var order []rune
	for _, page := range pages {
		for _, line := range page {
			for _, r := range line {
				if _, ok := cids[r]; !ok {
					cids[r] = len(order) + 1
					order = append(order, r)
				}
			}
		}
	}

	var cmap strings.Builder
	cmap.WriteString("/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n" +
		"/CIDSystemInfo << /Registry (Adobe) /Ordering (UCS) /Supplement 0 >> def\n" +
		"/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n" +
		"1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n")
	for i := 0; i < len(order); i += 100 {
		chunk := order[i:min(i+100, len(order))]
		fmt.Fprintf(&cmap, "%d beginbfchar\n", len(chunk))
		for _, r := range chunk {
			fmt.Fprintf(&cmap, "<%04X> <%04X>\n", cids[r], r)
		}
		cmap.WriteString("endbfchar\n")
	}
	cmap.WriteString("endcmap\nCMapName currentdict /CMap defineresource pop\nend\nend\n")

	objs := []string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"", // дерево страниц — когда известны номера страниц
		"<< /Type /Font /Subtype /Type0 /BaseFont /TestSans /Encoding /Identity-H " +
			"/DescendantFonts [4 0 R] /ToUnicode 5 0 R >>",
		"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /TestSans " +
			"/CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> " +
			"/FontDescriptor 6 0 R /DW 500 >>",
		stream(cmap.String()),
		"<< /Type /FontDescriptor /FontName /TestSans /Flags 32 /FontBBox [0 0 1000 1000] " +
			"/ItalicAngle 0 /Ascent 800 /Descent -200 /CapHeight 700 /StemV 80 >>",
	}
	var kids []string
	for _, page := range pages {
		var content strings.Builder
		content.WriteString("BT\n/F1 11 Tf\n")
		for i, line := range page {
			fmt.Fprintf(&content, "1 0 0 1 50 %d Tm\n<", 800-16*i)
			for _, r := range line {
				fmt.Fprintf(&content, "%04X", cids[r])
			}
			content.WriteString("> Tj\n")
		}
		content.WriteString("ET\n")
		objs = append(objs, stream(content.String()))
		contentID := len(objs)
		objs = append(objs, fmt.Sprintf("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] "+
			"/Resources << /Font << /F1 3 0 R >> >> /Contents %d 0 R >>", contentID))
		kids = append(kids, fmt.Sprintf("%d 0 R", len(objs)))
	}
	objs[1] = fmt.Sprintf("<< /Type /Pages /Kids [%s] /Count %d >>", strings.Join(kids, " "), len(pages))
	return assemble(objs)
}

// Scan — PDF без текстового слоя: страница с одной картинкой, как у
// сканера. Картинка — серый квадрат 2×2.
func Scan() []byte {
	return assemble([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
			"/Resources << /XObject << /Im1 5 0 R >> >> /Contents 4 0 R >>",
		stream("q 595 0 0 842 0 0 cm /Im1 Do Q\n"),
		"<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceGray " +
			"/BitsPerComponent 8 /Length 4 >>\nstream\n\x80\x80\x80\x80\nendstream",
	})
}

// Bomb — PDF, где сжатый поток страницы распаковывается в строку из n
// байт: килобайты на диске, сотни мегабайт в памяти разборщика.
func Bomb(n int) []byte {
	var z bytes.Buffer
	w, _ := zlib.NewWriterLevel(&z, zlib.BestCompression)
	_, _ = w.Write([]byte("BT /F1 11 Tf ("))
	chunk := bytes.Repeat([]byte("A"), 1<<20)
	for left := n; left > 0; left -= len(chunk) {
		_, _ = w.Write(chunk[:min(left, len(chunk))])
	}
	_, _ = w.Write([]byte(") Tj ET\n"))
	_ = w.Close()
	return assemble([]string{
		"<< /Type /Catalog /Pages 2 0 R >>",
		"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
		"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] " +
			"/Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents 4 0 R >>",
		fmt.Sprintf("<< /Length %d /Filter /FlateDecode >>\nstream\n%s\nendstream", z.Len(), z.String()),
	})
}

func stream(data string) string {
	return fmt.Sprintf("<< /Length %d >>\nstream\n%s\nendstream", len(data), data)
}

// assemble раскладывает объекты по файлу и пишет таблицу смещений.
func assemble(objs []string) []byte {
	var b bytes.Buffer
	b.WriteString("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
	offsets := make([]int, len(objs))
	for i, obj := range objs {
		offsets[i] = b.Len()
		fmt.Fprintf(&b, "%d 0 obj\n%s\nendobj\n", i+1, obj)
	}
	xref := b.Len()
	fmt.Fprintf(&b, "xref\n0 %d\n0000000000 65535 f \n", len(objs)+1)
	for _, off := range offsets {
		fmt.Fprintf(&b, "%010d 00000 n \n", off)
	}
	fmt.Fprintf(&b, "trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n", len(objs)+1, xref)
	return b.Bytes()
}
