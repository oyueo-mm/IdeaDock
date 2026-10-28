import { zipSync, strToU8 } from "fflate";
export const pixel = Uint8Array.from(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
    "base64",
  ),
);
export function docxFixture(
  body = `<w:p><w:r><w:t>오목 AI</w:t></w:r></w:p><w:p><w:r><w:t>첫 번째 설명입니다.</w:t></w:r></w:p><w:p><w:r><w:t>여러 문단을 하나로 보존합니다.</w:t></w:r></w:p><w:p><w:r><w:t>=====</w:t></w:r></w:p><w:p><w:r><w:t>명지대 통닭트럭</w:t></w:r></w:p><w:p><w:hyperlink r:id="link"><w:r><w:t>실제 참고 게시글</w:t></w:r></w:hyperlink><w:r><w:drawing><a:blip r:embed="image"/></w:drawing></w:r></w:p>`,
  extension = "png",
) {
  return zipSync(
    {
      "[Content_Types].xml": strToU8(
        `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="${extension}" ContentType="${extension === "png" ? "image/png" : "image/x-emf"}"/></Types>`,
      ),
      "word/document.xml": strToU8(
        `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><w:body>${body}</w:body></w:document>`,
      ),
      "word/_rels/document.xml.rels": strToU8(
        `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="image" Target="media/map.${extension}"/><Relationship Id="link" Target="https://example.com/actual-post" TargetMode="External"/></Relationships>`,
      ),
      [`word/media/map.${extension}`]: pixel,
    },
    { mtime: new Date("2020-01-01T00:00:00.000Z") },
  );
}
