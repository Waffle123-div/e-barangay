import multer from 'multer';
import path from 'path';

const memoryStorage = multer.memoryStorage();

function makeFilter(allowedExts) {
    return (req, file, cb) => {
        const ext = path.extname(file.originalname || '').toLowerCase().replace(/^\./, '');
        if (!allowedExts.includes(ext)) {
            const err = new Error(`Invalid file extension (.${ext}). Allowed: ${allowedExts.join(', ')}`);
            err.status = 422;
            err.isUploadValidation = true;
            return cb(err);
        }
        cb(null, true);
    };
}

export const uploadImageOrPdf10MB = multer({
    storage: memoryStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'pdf', 'webp']),
});

export const uploadRegistrationFiles = multer({
    storage: memoryStorage,
    limits: { fileSize: 10 * 1024 * 1024, fieldSize: 8 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'pdf', 'webp']),
});

export const uploadImage2MB = multer({
    storage: memoryStorage,
    limits: { fileSize: 2 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'webp', 'gif']),
});

export const uploadImage5MB = multer({
    storage: memoryStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'webp', 'gif']),
});

export const uploadValidId5MB = multer({
    storage: memoryStorage,
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'webp', 'pdf']),
});

export const uploadDocx10MB = multer({
    storage: memoryStorage,
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: makeFilter(['docx', 'doc']),
});

export const uploadAnySettings = multer({
    storage: memoryStorage,
    limits: { fileSize: 4 * 1024 * 1024 },
    fileFilter: makeFilter(['jpg', 'jpeg', 'png', 'webp', 'gif', 'svg']),
});

export const uploadNone = multer({
    storage: memoryStorage,
    limits: { fieldSize: 2 * 1024 * 1024 },
});
