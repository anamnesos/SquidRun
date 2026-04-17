const { Document, Packer, Paragraph, Table, TableRow, TableCell, TextRun, HeadingLevel, AlignmentType, WidthType, BorderStyle, ShadingType } = require('docx');
const fs = require('fs');

const headerShading = { type: ShadingType.SOLID, color: '2C3E50', fill: '2C3E50' };
const headerText = { bold: true, color: 'FFFFFF', size: 20, font: '맑은 고딕' };
const cellText = { size: 20, font: '맑은 고딕' };
const cellBold = { bold: true, size: 20, font: '맑은 고딕' };
const bodyFont = { size: 24, font: '휴먼명조' };
const bodyBold = { bold: true, size: 24, font: '휴먼명조' };

function headerCell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ ...headerText, ...opts, text })] })],
    shading: headerShading,
    verticalAlign: 'center',
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
  });
}

function cell(text, opts = {}) {
  return new TableCell({
    children: [new Paragraph({ children: [new TextRun({ ...cellText, ...opts, text })] })],
    verticalAlign: 'center',
    width: opts.width ? { size: opts.width, type: WidthType.PERCENTAGE } : undefined,
    shading: opts.shading,
  });
}

const doc = new Document({
  sections: [{
    properties: {
      page: { margin: { top: 1134, bottom: 850, left: 1134, right: 1134 } }
    },
    children: [
      // TITLE
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 32, text: '「2026년 제27회 여성창업경진대회」 사업계획서' })], alignment: AlignmentType.CENTER, spacing: { after: 400 } }),

      // OVERVIEW TABLE
      new Table({ rows: [
        new TableRow({ children: [headerCell('사업(아이템)명', { width: 25 }), cell('NurseCura — 간호사 경험 기반 산모·신생아 헬스케어 큐레이션 서비스')] }),
        new TableRow({ children: [headerCell('주요제품', { width: 25 }), cell('간호사 선별 기반 산모·신생아 안전 케어 제품')] }),
        new TableRow({ children: [headerCell('개발 단계', { width: 25 }), cell('제품화 완료')] }),
        new TableRow({ children: [headerCell('지원 분야', { width: 25 }), cell('라이프·소비재')] }),
        new TableRow({ children: [headerCell('전문기술분야', { width: 25 }), cell('여성 케어')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      // 1. 개요
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '1. 개요' })], heading: HeadingLevel.HEADING_2, spacing: { before: 400, after: 200 } }),
      new Paragraph({ children: [new TextRun({ ...bodyFont, text: '간호사 임상 경험을 바탕으로 산모와 신생아를 위한 헬스케어 제품을 선별하여 온라인(스마트스토어/쿠팡)으로 판매하는 큐레이션 서비스입니다.' })], spacing: { after: 100 } }),
      new Paragraph({ children: [new TextRun({ ...bodyFont, text: '강남세브란스병원 NICU(신생아중환자실), 정형외과, 아동병원, 요양병원, 이비인후과, 보건교사 등 다양한 의료 현장 경험을 활용하여 제품 안전성을 검토하고, 신뢰할 수 있는 제품만 소비자에게 제공합니다.' })], spacing: { after: 100 } }),
      new Paragraph({ children: [new TextRun({ ...bodyFont, text: '저출산 시대에 부모의 선택 피로도를 줄이고, 전문가 검증을 통한 영유아 건강 증진에 기여하고자 합니다.' })], spacing: { after: 200 } }),

      // 2. 차별성
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '2. 차별성' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('구분'), headerCell('일반 온라인 셀러'), headerCell('NurseCura')] }),
        new TableRow({ children: [cell('전문성', { bold: true }), cell('전문 지식 없이 가격 경쟁'), cell('NICU 출신 간호사가 임상 경험으로 제품 선별')] }),
        new TableRow({ children: [cell('신뢰도', { bold: true }), cell('리뷰/별점에 의존'), cell('간호사 경력 기반 전문가 큐레이션')] }),
        new TableRow({ children: [cell('해외 경험', { bold: true }), cell('국내 제품 위주'), cell('미국 6년 거주, 해외 헬스케어 트렌드 이해')] }),
        new TableRow({ children: [cell('시장 확장', { bold: true }), cell('국내 한정'), cell('해외 한인 산모 시장 확장 가능성')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      // 3. 시장성 및 기대효과
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '3. 시장성 및 기대효과' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Paragraph({ children: [
        new TextRun({ ...bodyBold, text: '시장 환경: ' }),
        new TextRun({ ...bodyFont, text: '저출산 시대에도 1인당 영유아 지출은 증가하는 "골드키즈" 트렌드가 지속되고 있습니다. 온라인 산모/신생아 용품 시장은 성장 중이나, 전문가 검수 기반의 셀러는 부족한 상황입니다.' }),
      ], spacing: { after: 200 } }),
      new Paragraph({ children: [new TextRun({ ...bodyBold, text: '비즈니스 모델:' })], spacing: { after: 100 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('단계'), headerCell('매출 경로'), headerCell('목표')] }),
        new TableRow({ children: [cell('1단계'), cell('네이버 스마트스토어 / 쿠팡'), cell('월 매출 100만원')] }),
        new TableRow({ children: [cell('2단계'), cell('SNS(인스타그램) / 라이브커머스'), cell('월 매출 300만원')] }),
        new TableRow({ children: [cell('3단계'), cell('해외 한인 산모 시장'), cell('월 매출 500만원')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),
      new Paragraph({ children: [
        new TextRun({ ...bodyBold, text: '기대효과: ' }),
        new TextRun({ ...bodyFont, text: '산모와 신생아 부모가 전문가의 검증을 거친 안전한 제품을 쉽게 구매할 수 있는 환경을 조성하여, 영유아 건강 증진 및 부모의 제품 선택 부담 경감에 기여.' }),
      ], spacing: { before: 200, after: 200 } }),

      // 4. 추진 계획
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '4. 추진 계획' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('단계'), headerCell('기간'), headerCell('세부 내용')] }),
        new TableRow({ children: [cell('1단계 (준비)'), cell('현재 ~ 2026.06'), cell('시장 조사 및 브랜드 컨셉 확립. 유튜브/SNS 채널 개설 및 전문가 브랜딩 콘텐츠 업로드 (실업급여 수급 기간 내 준비 활동)')] }),
        new TableRow({ children: [cell('2단계 (구축)'), cell('2026.07 ~ 2026.08'), cell('주요 상품 소싱처 확보 및 패키지 시제품 구성. 정부 지원사업 신청을 통한 사업 자금 확보')] }),
        new TableRow({ children: [cell('3단계 (런칭)'), cell('2026.08.17 ~'), cell('사업자 등록 완료 및 온라인 쇼핑몰 정식 런칭. 숏츠 마케팅 본격화를 통한 매출 창출')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      // 5. 대표자 역량
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '5. 대표자 및 팀원의 보유역량' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Paragraph({ children: [new TextRun({ ...bodyBold, text: '대표자 역량:' })], spacing: { after: 100 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('주요역량'), headerCell('내용'), headerCell('비고')] }),
        new TableRow({ children: [cell('의료 전문성'), cell('대학병원 NICU, 정형외과, 이비인후과, 아동병원, 요양병원, 보건교사 경력'), cell('제품 안전성 검수 역량')] }),
        new TableRow({ children: [cell('해외 경험'), cell('미국 6년 이상 거주, 영어 능통'), cell('해외 시장 이해 및 소싱')] }),
        new TableRow({ children: [cell('교육/커뮤니케이션'), cell('보건교육, 감염병 관리, 응급처치, 건강관리 교육 경력'), cell('SNS 콘텐츠 제작 역량')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      new Paragraph({ children: [new TextRun({ ...bodyBold, text: '대표자 주요이력:' })], spacing: { before: 200, after: 100 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('기간'), headerCell('기관'), headerCell('직무')] }),
        new TableRow({ children: [cell('2008.01 ~ 2010.04'), cell('강남세브란스병원 간호국'), cell('간호사 (NICU/정형외과)')] }),
        new TableRow({ children: [cell('2010.07 ~ 2011.01'), cell('함춘요양병원'), cell('간호사')] }),
        new TableRow({ children: [cell('2011 ~ 2017'), cell('미국 거주 (6년)'), cell('해외 경험')] }),
        new TableRow({ children: [cell('2017.05 ~ 2017.09'), cell('동래아동병원'), cell('간호사')] }),
        new TableRow({ children: [cell('2018.08 ~ 2018.09'), cell('미래산업보건의료재단'), cell('산업체간호사')] }),
        new TableRow({ children: [cell('2019.01 ~ 2019.04'), cell('삼인요양병원'), cell('간호사')] }),
        new TableRow({ children: [cell('2019.06 ~ 2020.02'), cell('학력인정부경보건고'), cell('보건교사, 간호수업')] }),
        new TableRow({ children: [cell('2020.03 ~ 2021.02'), cell('부산배화학교'), cell('보건교사')] }),
        new TableRow({ children: [cell('2022.03 ~ 2022.03'), cell('삼당초등학교'), cell('보건교사')] }),
        new TableRow({ children: [cell('2024.10 ~ 2025.02'), cell('동남권원자력의학원 이비인후과'), cell('전담간호사')] }),
        new TableRow({ children: [cell('2025.03 ~ 2026.02'), cell('부산해마루학교'), cell('보건교사')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),
      new Paragraph({ children: [new TextRun({ ...bodyBold, text: '보유 자격: ' }), new TextRun({ ...bodyFont, text: '간호사면허, 보육교사 2급, 요양보호사' })], spacing: { before: 100, after: 200 } }),

      // 6. 자금 조달
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '6. 향후 자금 조달 계획' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('매출 역량'), headerCell('투자 유치')] }),
        new TableRow({ children: [
          cell('1단계: 스마트스토어/쿠팡 월 매출 100만원\n2단계: 다채널 확장 월 매출 300만원\n3단계: 해외 시장 월 매출 500만원\n마진율 25~30% 목표'),
          cell('자기자본 500만원\n엔젤투자/크라우드펀딩 검토\n매출 성장 후 시드투자 유치 검토')
        ] }),
        new TableRow({ children: [headerCell('지원사업'), headerCell('정책자금')] }),
        new TableRow({ children: [
          cell('여성창업경진대회 사업화자금 (최대 1,000만원)\n예비창업패키지 (최대 1억원)\n여성기업 글로벌 수출패키지'),
          cell('소상공인 정책자금 (저금리 융자)\n여성기업 전용 자금\n지자체 창업지원 융자')
        ] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      // 7. 성장전략
      new Paragraph({ children: [new TextRun({ ...bodyBold, size: 28, text: '7. 성장 전략 — 중장기 성장 계획' })], heading: HeadingLevel.HEADING_2, spacing: { before: 300, after: 200 } }),
      new Paragraph({ children: [new TextRun({ ...bodyBold, text: '판매플랫폼 구축:' })], spacing: { after: 100 } }),
      new Table({ rows: [
        new TableRow({ children: [headerCell('순번'), headerCell('구분'), headerCell('주요 채널')] }),
        new TableRow({ children: [cell('1'), cell('오픈마켓'), cell('쿠팡, 11번가, 옥션, G마켓 등')] }),
        new TableRow({ children: [cell('2'), cell('SNS마켓'), cell('인스타그램, 라이브커머스 등')] }),
        new TableRow({ children: [cell('3'), cell('산모·육아 전문몰'), cell('맘스홀릭, 베이비트리 등')] }),
        new TableRow({ children: [cell('4'), cell('커뮤니티'), cell('맘카페(네이버), 육아대백과 등')] }),
        new TableRow({ children: [cell('5'), cell('자체쇼핑몰 구축'), cell('자체 쇼핑몰, 스마트스토어 등')] }),
      ], width: { size: 100, type: WidthType.PERCENTAGE } }),

      // NOTE
      new Paragraph({ children: [new TextRun({ color: 'FF0000', bold: true, size: 22, font: '맑은 고딕', text: '※ 개인정보(휴대전화번호, 주민등록번호, 주소)만 직접 기입 후 제출' })], alignment: AlignmentType.CENTER, spacing: { before: 400 } }),
      new Paragraph({ children: [new TextRun({ color: 'FF0000', size: 20, font: '맑은 고딕', text: '※ 대표 이미지 칸에 로고 또는 서비스 흐름도 삽입 필요' })], alignment: AlignmentType.CENTER }),
      new Paragraph({ children: [new TextRun({ color: 'FF0000', size: 20, font: '맑은 고딕', text: '※ PDF 변환 후 제출 (최대 10페이지, 15MB 이하)' })], alignment: AlignmentType.CENTER }),
    ]
  }]
});

(async () => {
  const buffer = await Packer.toBuffer(doc);
  const outPath = 'D:\\projects\\squidrun\\workspace\\NurseCura_사업계획서_완성본.docx';
  fs.writeFileSync(outPath, buffer);
  console.log('Created:', outPath);
  console.log('Size:', (buffer.length / 1024).toFixed(1), 'KB');
})();
