import Docxtemplater from 'docxtemplater';
import PizZip from 'pizzip';
import { AlignmentType, Document, Packer, Paragraph, TextRun, UnderlineType } from 'docx';
import { queryOne } from '../db/pool.js';
import { BarangaySetting, hydrateUser } from '../lib/models.js';
import { formatDate } from '../lib/viewHelpers.js';
import { readFileBuffer } from './storageService.js';

export function numberToWords(number) {
    const n = Number(number) || 0;
    const whole = Math.floor(n);
    const fraction = Math.round((n - whole) * 100);

    if (whole === 0 && fraction === 0) return 'ZERO PESOS ONLY';

    const ones = [
        '', 'ONE', 'TWO', 'THREE', 'FOUR', 'FIVE', 'SIX', 'SEVEN', 'EIGHT', 'NINE',
        'TEN', 'ELEVEN', 'TWELVE', 'THIRTEEN', 'FOURTEEN', 'FIFTEEN', 'SIXTEEN',
        'SEVENTEEN', 'EIGHTEEN', 'NINETEEN',
    ];
    const tens = ['', '', 'TWENTY', 'THIRTY', 'FORTY', 'FIFTY', 'SIXTY', 'SEVENTY', 'EIGHTY', 'NINETY'];

    const convertChunk = (val) => {
        if (val === 0) return '';
        if (val < 20) return ones[val];
        if (val < 100) return tens[Math.floor(val / 10)] + (val % 10 ? ' ' + ones[val % 10] : '');
        if (val < 1000) {
            return ones[Math.floor(val / 100)] + ' HUNDRED' + (val % 100 ? ' ' + convertChunk(val % 100) : '');
        }
        return '';
    };

    const words = [];
    let rem = whole;
    if (rem >= 1000000) {
        words.push(`${convertChunk(Math.floor(rem / 1000000))} MILLION`);
        rem %= 1000000;
    }
    if (rem >= 1000) {
        words.push(`${convertChunk(Math.floor(rem / 1000))} THOUSAND`);
        rem %= 1000;
    }
    if (rem > 0) words.push(convertChunk(rem));

    const pesosPart = `${words.join(' ').trim()} PESOS`;
    if (fraction > 0) {
        return `${pesosPart} AND ${convertChunk(fraction)} CENTAVOS ONLY`.trim();
    }
    return `${pesosPart} ONLY`.trim();
}

const FALLBACK_TEMPLATE_MAP = {
    'Barangay Clearance': { templateFile: 'clearance_template.docx', outputName: 'Clearance' },
    'Senior Citizen Certification': { templateFile: 'senior_citizen_certification_template.docx', outputName: 'Senior_Citizen_Certification' },
    'Certification for Senior Citizen': { templateFile: 'senior_citizen_certification_template.docx', outputName: 'Senior_Citizen_Certification' },
    'Certification for Senior Citizen Cash Assistance': { templateFile: 'senior_citizen_cash_assistance_template.docx', outputName: 'Senior_Citizen_Cash_Assistance' },
    'Cash Assistance Senior Certificate': { templateFile: 'senior_citizen_cash_assistance_template.docx', outputName: 'Senior_Citizen_Cash_Assistance' },
    'Certification for Burial Assistance': { templateFile: 'burial_assistance_template.docx', outputName: 'Burial_Assistance' },
    'Burial Senior Citizen Certificate': { templateFile: 'burial_assistance_template.docx', outputName: 'Burial_Assistance' },
    'Burial Assistance': { templateFile: 'burial_assistance_template.docx', outputName: 'Burial_Assistance' },
    'Barangay Business Clearance': { templateFile: 'business_clearance_template.docx', outputName: 'Business_Clearance' },
    'Business Permit': { templateFile: 'business_clearance_template.docx', outputName: 'Business_Clearance' },
    'Brgy Clearance for Business Permit': { templateFile: 'business_clearance_template.docx', outputName: 'Business_Clearance' },
    'Barangay Certification for Electric Connection': { templateFile: 'electric_connection_template.docx', outputName: 'Electric_Connection_Certificate' },
    'Electric Connection Certificate': { templateFile: 'electric_connection_template.docx', outputName: 'Electric_Connection_Certificate' },
    'Electric Certificate': { templateFile: 'electric_connection_template.docx', outputName: 'Electric_Connection_Certificate' },
    'Acknowledgement Receipt': { templateFile: 'acknowledgement_receipt_template.docx', outputName: 'Acknowledgement_Receipt' },
    'Certificate of Cohabitation': { templateFile: 'cohabitation_certificate_template.docx', outputName: 'Certificate_of_Cohabitation' },
    'Cohabitation Certificate': { templateFile: 'cohabitation_certificate_template.docx', outputName: 'Certificate_of_Cohabitation' },
    'Barangay Certificate': { templateFile: 'barangay_certificate_template.docx', outputName: 'Barangay_Certificate' },
    'Barangay Certification (R.A. 11261 - First Time Jobseeker)': { templateFile: 'first_time_jobseeker_template.docx', outputName: 'First_Time_Jobseeker_Certification' },
    'Barangay Certification (First Time Jobseeker)': { templateFile: 'first_time_jobseeker_template.docx', outputName: 'First_Time_Jobseeker_Certification' },
    'First Time Job Seeker': { templateFile: 'first_time_jobseeker_template.docx', outputName: 'First_Time_Jobseeker_Certification' },
    'First Time Jobseeker': { templateFile: 'first_time_jobseeker_template.docx', outputName: 'First_Time_Jobseeker_Certification' },
    'Certificate of Residency': { templateFile: 'residency_template.docx', outputName: 'Residency' },
    'Certificate of Indigency': { templateFile: 'indigency_template.docx', outputName: 'Indigency' },
    'Barangay Certification (For Probation & Bail)': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Barangay Certification (For Probation and Bail)': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Probation & Bail': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Probation and Bail': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Indigency Bail Certificate': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Bail Certificate': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Probation Barangay Certificate': { templateFile: 'probation_bail_template.docx', outputName: 'Probation_and_Bail_Certification' },
    'Oath of Undertaking (R.A. 11261)': { templateFile: 'oath_of_undertaking_template.docx', outputName: 'Oath_of_Undertaking' },
    'Oath of Undertaking': { templateFile: 'oath_of_undertaking_template.docx', outputName: 'Oath_of_Undertaking' },
    'Oath of Undertaking Job Seeker': { templateFile: 'oath_of_undertaking_template.docx', outputName: 'Oath_of_Undertaking' },
};

async function buildDynamicFallbackDocx({
    barangayName,
    city,
    province,
    captain,
    normalizedDocType,
    residentName,
    purok,
    age,
    purpose,
    trackingNumber,
}) {
    let docTitle = normalizedDocType.toUpperCase();
    if (!docTitle.includes('CERTIFICATE') && !docTitle.includes('CLEARANCE') && !docTitle.includes('PERMIT')) {
        docTitle = `BARANGAY CERTIFICATE (${docTitle})`;
    }

    const address = purok ? `of ${purok}` : 'of this barangay';
    const ageText = age ? `${age} years of age` : 'of legal age';
    const effectivePurpose = (purpose || 'WHATEVER LEGAL PURPOSE IT MAY SERVE').toUpperCase();
    const issuedDate = formatDate(new Date(), 'jS day of F, Y');
    const year = new Date().getFullYear();

    const doc = new Document({
        sections: [
            {
                properties: {
                    page: { margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } },
                },
                children: [
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Republic of the Philippines', font: 'Times New Roman', size: 22 })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Province of ${province}`, font: 'Times New Roman', size: 22 })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Municipality/City of ${city}`, font: 'Times New Roman', size: 22 })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `BARANGAY ${barangayName}`, font: 'Times New Roman', size: 28, bold: true })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 240 }, children: [new TextRun({ text: 'OFFICE OF THE PUNONG BARANGAY', font: 'Times New Roman', size: 22, italics: true })] }),

                    new Paragraph({
                        alignment: AlignmentType.CENTER,
                        spacing: { after: 360 },
                        children: [new TextRun({ text: docTitle, font: 'Times New Roman', size: 32, bold: true, underline: { type: UnderlineType.SINGLE } })],
                    }),

                    new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: 'TO WHOM IT MAY CONCERN:', font: 'Times New Roman', size: 24, bold: true })] }),

                    new Paragraph({
                        alignment: AlignmentType.JUSTIFIED,
                        spacing: { after: 200 },
                        children: [
                            new TextRun({ text: '\tThis is to certify that ', font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: residentName, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: ', ', font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: ageText, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: `, Filipino citizen, is a bonafide resident ${address}, `, font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: `Barangay ${barangayName}, ${city}, ${province}`, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: '.', font: 'Times New Roman', size: 24 }),
                        ],
                    }),

                    new Paragraph({
                        alignment: AlignmentType.JUSTIFIED,
                        spacing: { after: 200 },
                        children: [
                            new TextRun({ text: '\tThis certification is issued upon the request of the above-named person for the purpose of ', font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: effectivePurpose, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: ' and for whatever legal intent it may serve.', font: 'Times New Roman', size: 24 }),
                        ],
                    }),

                    new Paragraph({
                        alignment: AlignmentType.JUSTIFIED,
                        spacing: { after: 240 },
                        children: [
                            new TextRun({ text: 'Issued this ', font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: issuedDate, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: ' at the Barangay Hall of Barangay ', font: 'Times New Roman', size: 24 }),
                            new TextRun({ text: `${barangayName}, ${city}, ${province}`, font: 'Times New Roman', size: 24, bold: true }),
                            new TextRun({ text: '.', font: 'Times New Roman', size: 24 }),
                        ],
                    }),

                    new Paragraph({ spacing: { after: 480 }, children: [new TextRun({ text: `Tracking No: ${trackingNumber}`, font: 'Times New Roman', size: 20, italics: true, bold: true })] }),

                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `HON. ${captain}`, font: 'Times New Roman', size: 24, bold: true })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 360 }, children: [new TextRun({ text: 'Punong Barangay', font: 'Times New Roman', size: 22 })] }),
                    new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: `Doc No. _____ Page No. _____ Book No. _____ Series of ${year}`, font: 'Times New Roman', size: 20 })] }),
                ],
            },
        ],
    });

    return Packer.toBuffer(doc);
}

export async function generateWordDocumentBuffer(docRequest, docTypeName, purposeOverride = null, options = {}) {
    const settings = options.settings || (await BarangaySetting.allAssoc());
    const barangayName = String(settings.barangay_name || 'Barangay Cogon East').toUpperCase();
    const city = settings.city_municipality || settings.municipality || 'Carmen';
    const province = settings.province || 'Cebu';
    const captain = String(settings.barangay_captain || settings.punong_barangay || 'Hon. Punong Barangay').toUpperCase();
    const secretary = String(settings.barangay_secretary || settings.secretary || 'Barangay Secretary').toUpperCase();
    const treasurer = String(settings.barangay_treasurer || settings.treasurer || 'HON. BARANGAY TREASURER').toUpperCase();

    const normalizedDocType = String(docTypeName || '').trim();
    const cleanDoc = normalizedDocType.replace(/[^A-Za-z0-9_]/g, '_') || 'Document';
    let outputName = cleanDoc;
    let templateFile = '';
    let customTemplatePath = null;

    if (!options.skipDbLookup) {
        let docTypeRecord = null;
        if (docRequest.document_type_id) {
            docTypeRecord = await queryOne('SELECT * FROM document_types WHERE id = $1 LIMIT 1', [docRequest.document_type_id]);
        }
        if (!docTypeRecord && normalizedDocType) {
            docTypeRecord = await queryOne('SELECT * FROM document_types WHERE name = $1 LIMIT 1', [normalizedDocType]);
        }
        if (docTypeRecord?.template_file) {
            customTemplatePath = docTypeRecord.template_file;
        }
    } else if (options.templateFileOverride) {
        customTemplatePath = options.templateFileOverride;
    }

    const mapped = FALLBACK_TEMPLATE_MAP[normalizedDocType];
    if (mapped) {
        if (!customTemplatePath) templateFile = mapped.templateFile;
        outputName = mapped.outputName;
    }

    let user = docRequest.user || null;
    if (!user && !options.skipDbLookup) {
        if (docRequest.user_id) {
            user = hydrateUser(await queryOne('SELECT * FROM users WHERE id = $1 LIMIT 1', [docRequest.user_id]));
        } else if (docRequest.resident_email) {
            user = hydrateUser(await queryOne('SELECT * FROM users WHERE email = $1 LIMIT 1', [docRequest.resident_email]));
        }
    }

    const residentName = String(docRequest.resident_name || 'RESIDENT APPLICANT').toUpperCase();
    const safeName = residentName.replace(/[^A-Za-z0-9_-]/g, '_');
    const safeTracking = String(docRequest.tracking_number || 'REQ').replace(/[^A-Za-z0-9_-]/g, '_');
    const fileName = `${safeName}_${outputName}_${safeTracking}.docx`;

    const civilStatus = String(docRequest.civil_status || user?.civil_status || 'SINGLE').toUpperCase();
    const orNumber = docRequest.or_number || docRequest.or_no || String(docRequest.tracking_number || '').replace('REQ', 'REC');
    const numericFee = docRequest.fee !== null && docRequest.fee !== undefined && Number(docRequest.fee) > 0 ? Number(docRequest.fee) : 0;
    const amountFormatted = numericFee.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    let rawAge = docRequest.age || user?.age || null;
    if (!rawAge && user?.birthdate) {
        const bd = new Date(user.birthdate);
        if (!Number.isNaN(bd.getTime())) {
            rawAge = Math.floor((Date.now() - bd.getTime()) / (365.25 * 24 * 60 * 60 * 1000));
        }
    }
    const cleanAgeDigits = rawAge ? String(rawAge).replace(/[^0-9]/g, '').trim() : '';
    const cleanAge = cleanAgeDigits || (rawAge ? String(rawAge) : 'legal age');

    let purokVal = docRequest.purok || user?.purok || '';
    if (purokVal !== '' && /^\d+$/.test(String(purokVal).trim())) {
        purokVal = `Purok ${String(purokVal).trim()}`;
    }

    let birthdateFormatted = 'N/A';
    if (user?.birthdate) {
        birthdateFormatted = formatDate(user.birthdate, 'F d, Y');
    } else if (docRequest.birthdate) {
        birthdateFormatted = formatDate(docRequest.birthdate, 'F d, Y');
    } else if (cleanAgeDigits) {
        const approx = new Date();
        approx.setFullYear(approx.getFullYear() - Number(cleanAgeDigits));
        birthdateFormatted = formatDate(approx, 'F d, Y');
    }

    const effectivePurpose = String(purposeOverride || docRequest.purpose || 'Whatever legal purpose it may serve').toUpperCase();
    const now = new Date();

    const mergeData = {
        name: residentName,
        resident_name: residentName,
        full_name: residentName,
        tracking_number: docRequest.tracking_number || '',
        date: formatDate(now, 'jS day of F, Y'),
        day: formatDate(now, 'jS'),
        month: formatDate(now, 'F'),
        year: formatDate(now, 'Y'),
        current_date: formatDate(now, 'F d, Y'),
        age: cleanAge,
        civil_status: civilStatus,
        purpose: effectivePurpose,
        barangay_name: barangayName,
        city,
        province,
        captain,
        captain_name: captain,
        punong_barangay: captain,
        secretary,
        secretary_name: secretary,
        barangay_secretary: secretary,
        birthdate: birthdateFormatted,
        deceased_name: docRequest.deceased_name ? String(docRequest.deceased_name).toUpperCase() : 'THE DECEASED RESIDENT',
        date_of_death: docRequest.date_of_death ? formatDate(docRequest.date_of_death, 'F d, Y') : formatDate(now, 'F d, Y'),
        relationship: docRequest.relationship || 'authorized family member',
        business_name: docRequest.business_name ? String(docRequest.business_name).toUpperCase() : 'REGISTERED BUSINESS',
        business_address: docRequest.business_address ? String(docRequest.business_address).toUpperCase() : `BARANGAY ${barangayName}, ${city}, ${province}`,
        treasurer_name: treasurer,
        barangay_treasurer: treasurer,
        amount_in_words: numberToWords(numericFee),
        partner_name: docRequest.partner_name ? String(docRequest.partner_name).toUpperCase() : (docRequest.partner ? String(docRequest.partner).toUpperCase() : 'COMMON-LAW PARTNER'),
        years_cohabitating: docRequest.years_cohabitating || docRequest.years || '5',
        residence_years: docRequest.residence_years || docRequest.years || '5',
        address: String(docRequest.address || '').toUpperCase(),
        purok: String(purokVal).toUpperCase(),
        contact_number: docRequest.contact_number || '',
        email: docRequest.resident_email || '',
        id_type: docRequest.id_type || 'None',
        fee: docRequest.fee !== null && docRequest.fee !== undefined ? `₱${Number(docRequest.fee).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : 'FREE',
        amount: amountFormatted,
        amount_paid: amountFormatted,
        or_number: orNumber,
        or_no: orNumber,
        document_type: normalizedDocType,
        document_title: normalizedDocType,
    };

    const templateCandidate = customTemplatePath || templateFile;
    let templateBuffer = null;
    if (templateCandidate) {
        const found = await readFileBuffer(templateCandidate, ['document_templates']);
        if (found?.buffer) {
            templateBuffer = found.buffer;
        }
    }

    if (templateBuffer) {
        const zip = new PizZip(templateBuffer);
        const doc = new Docxtemplater(zip, {
            delimiters: { start: '${', end: '}' },
            paragraphLoop: true,
            linebreaks: true,
            nullGetter: () => '',
        });
        doc.render(mergeData);
        const outBuffer = doc.getZip().generate({ type: 'nodebuffer', compression: 'DEFLATE' });
        return { buffer: outBuffer, fileName, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
    }

    const fallbackBuffer = await buildDynamicFallbackDocx({
        barangayName,
        city,
        province,
        captain,
        normalizedDocType,
        residentName,
        purok: purokVal,
        age: docRequest.age,
        purpose: effectivePurpose,
        trackingNumber: docRequest.tracking_number,
    });

    return {
        buffer: fallbackBuffer,
        fileName,
        contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
}

export async function bundleMultipleDocumentsZip(docRequest, docsList, options = {}) {
    const zip = new PizZip();
    for (let i = 0; i < docsList.length; i++) {
        const item = docsList[i];
        const itemType = item.type || docRequest.document_type;
        const itemPurpose = item.purpose || docRequest.purpose;
        const result = await generateWordDocumentBuffer(docRequest, itemType, itemPurpose, options);
        const uniqueName = zip.file(result.fileName) ? `${i + 1}_${result.fileName}` : result.fileName;
        zip.file(uniqueName, result.buffer);
    }

    const safeName = String(docRequest.resident_name || 'RESIDENT').replace(/[^A-Za-z0-9_-]/g, '_');
    const safeTracking = String(docRequest.tracking_number || 'REQ').replace(/[^A-Za-z0-9_-]/g, '_');
    return {
        buffer: zip.generate({ type: 'nodebuffer', compression: 'DEFLATE' }),
        fileName: `${safeName}_Documents_${safeTracking}.zip`,
        contentType: 'application/zip',
    };
}
