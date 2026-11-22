import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import {
    bundleMultipleDocumentsZip,
    generateWordDocumentBuffer,
    numberToWords,
} from '../src/services/wordService.js';

const offlineSettings = {
    barangay_name: 'Cogon East',
    city_municipality: 'Carmen',
    province: 'Cebu',
    barangay_captain: 'Hon. Juan Captain',
    barangay_secretary: 'Maria Secretary',
    barangay_treasurer: 'Pedro Treasurer',
};

const sampleRequest = {
    id: 10,
    user_id: 2,
    tracking_number: 'REQ-2026-00001',
    first_name: 'JUAN',
    middle_initial: 'S',
    last_name: 'DELA CRUZ',
    resident_name: 'JUAN S. DELA CRUZ',
    contact_number: '09171234567',
    resident_email: 'resident@example.com',
    purok: '1',
    street: 'Rizal St',
    address: 'Purok 1, Rizal St, Cogon East, Carmen, Cebu',
    age: '31',
    civil_status: 'Single',
    birthdate: '1995-05-05',
    id_type: 'National ID',
    purpose: 'EMPLOYMENT',
    fee: 50,
    document_type: 'Barangay Clearance',
    or_number: 'REC-2026-00001',
};

function inspectDocxBuffer(buf, label) {
    assert.ok(Buffer.isBuffer(buf), `${label}: expected Buffer`);
    assert.ok(buf.length > 500, `${label}: buffer suspiciously small (${buf.length} bytes)`);
    assert.equal(buf[0], 0x50, `${label}: expected 'P' zip magic byte`);
    assert.equal(buf[1], 0x4b, `${label}: expected 'K' zip magic byte`);

    const zip = new PizZip(buf);
    const docXmlFile = zip.file('word/document.xml');
    assert.ok(docXmlFile, `${label}: missing word/document.xml`);
    const xml = docXmlFile.asText();
    const plainText = xml.replace(/<[^>]+>/g, '');
    return { xml, plainText };
}

async function main() {
    // 1. Official template override (01_Barangay_Clearance_General.docx)
    const clearance = await generateWordDocumentBuffer(sampleRequest, 'Barangay Clearance', 'EMPLOYMENT', {
        skipDbLookup: true,
        settings: offlineSettings,
        templateFileOverride: 'document_templates/01_Barangay_Clearance_General.docx',
    });
    const clearanceDoc = inspectDocxBuffer(clearance.buffer, 'Clearance template');
    assert.ok(clearanceDoc.plainText.includes('JUAN S. DELA CRUZ'), 'Clearance XML must contain resident name');
    assert.ok(clearanceDoc.plainText.includes('REQ-2026-00001'), 'Clearance XML must contain tracking number');
    assert.ok(!/\$\{[^}]+\}/.test(clearanceDoc.plainText), 'Clearance XML must not contain leftover ${...} placeholders');
    console.log(`[PASS] Official template: ${clearance.fileName} (${clearance.buffer.length} bytes)`);

    // 2. Mapped root/fallback template (Certificate of Residency -> residency_template.docx)
    const residency = await generateWordDocumentBuffer(sampleRequest, 'Certificate of Residency', 'PROOF OF RESIDENCY', {
        skipDbLookup: true,
        settings: offlineSettings,
    });
    const residencyDoc = inspectDocxBuffer(residency.buffer, 'Residency template');
    assert.ok(residencyDoc.plainText.includes('JUAN S. DELA CRUZ'), 'Residency XML must contain resident name');
    assert.ok(!/\$\{[^}]+\}/.test(residencyDoc.plainText), 'Residency XML must not contain leftover ${...} placeholders');
    console.log(`[PASS] Mapped template: ${residency.fileName} (${residency.buffer.length} bytes)`);

    // 3. Dynamic docx fallback when no template exists
    const custom = await generateWordDocumentBuffer(sampleRequest, 'Custom Special Certificate', 'SCHOLARSHIP', {
        skipDbLookup: true,
        settings: offlineSettings,
    });
    const customDoc = inspectDocxBuffer(custom.buffer, 'Dynamic fallback');
    assert.ok(customDoc.plainText.includes('CUSTOM SPECIAL CERTIFICATE'), 'Fallback XML must contain CUSTOM SPECIAL CERTIFICATE title');
    assert.ok(customDoc.plainText.includes('JUAN S. DELA CRUZ'), 'Fallback XML must contain resident name');
    console.log(`[PASS] Dynamic fallback: ${custom.fileName} (${custom.buffer.length} bytes)`);

    // 4. Multi-document ZIP bundling
    const bundle = await bundleMultipleDocumentsZip(
        sampleRequest,
        [
            { type: 'Barangay Clearance', purpose: 'EMPLOYMENT' },
            { type: 'Certificate of Residency', purpose: 'LOAN APPLICATION' },
        ],
        {
            skipDbLookup: true,
            settings: offlineSettings,
        }
    );
    assert.equal(bundle.contentType, 'application/zip');
    assert.equal(bundle.buffer[0], 0x50);
    assert.equal(bundle.buffer[1], 0x4b);
    const outerZip = new PizZip(bundle.buffer);
    const docxEntries = Object.keys(outerZip.files).filter((k) => k.endsWith('.docx'));
    assert.equal(docxEntries.length, 2, `Expected 2 .docx entries in bundle ZIP, found ${docxEntries.length}`);
    console.log(`[PASS] Multi-document ZIP: ${bundle.fileName} (${docxEntries.join(', ')})`);

    // 5. numberToWords helper
    assert.equal(numberToWords(150.5), 'ONE HUNDRED FIFTY PESOS AND FIFTY CENTAVOS ONLY');
    assert.equal(numberToWords(0), 'ZERO PESOS ONLY');
    console.log('[PASS] numberToWords verification');
}

main().catch((err) => {
    console.error('[verify-word ERROR]', err);
    process.exit(1);
});
