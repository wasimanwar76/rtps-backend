const express = require("express");
const multer = require("multer");
const { createClient } = require("@supabase/supabase-js");
const axios = require("axios");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const { body, param, validationResult } = require("express-validator");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// --- CONFIGURATION ---
// SUPABASE_SERVICE_KEY is used for database/storage operations (Bypass RLS)
// SUPABASE_URL is your project URL
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY,
);

// --- MIDDLEWARE ---
app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(morgan("dev"));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB Limit per file
});

// --- HELPER: Unified Response Handler ---
const sendResponse = (res, status, success, message, data = null) => {
  return res.status(status).json({ success, message, data });
};

// --- HELPER: Supabase Storage Upload ---
async function uploadToSupabase(file, folder) {
  if (!file) return "";
  const fileName = `${folder}/${Date.now()}_${Math.floor(Math.random() * 1000)}_${file.originalname.replace(/\s/g, "_")}`;

  const { data, error } = await supabase.storage
    .from("documents")
    .upload(fileName, file.buffer, { contentType: file.mimetype });

  if (error) throw new Error(`Upload Error: ${error.message}`);

  const { data: urlData } = supabase.storage
    .from("documents")
    .getPublicUrl(fileName);
  return urlData.publicUrl;
}

// --- 1. AUTHENTICATION API (Supabase Auth) ---

/**
 * @route POST /api/auth/login
 * @desc Login using Supabase Auth
 */
app.post(
  "/api/auth/login",
  [
    body("email")
      .isEmail()
      .withMessage("Enter valid email / मान्य ईमेल दर्ज करें")
      .normalizeEmail(),
    body("password")
      .notEmpty()
      .withMessage("Password required / पासवर्ड अनिवार्य है"),
  ],
  async (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return sendResponse(res, 400, false, "Validation Failed", errors.array());
    }

    try {
      const { email, password } = req.body;

      // Supabase Authentication
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      // Standardizing Error Messages
      if (error) {
        // Log the internal error for admin monitoring
        console.error(`Auth Error: ${error.status} - ${error.message}`);

        return sendResponse(
          res,
          error.status || 401,
          false,
          `Login Failed: ${error.message} / लॉगिन विफल: क्रेडेंशियल जांचें`,
        );
      }

      // Successful Login
      // We return the access_token (JWT) and basic user info
      return sendResponse(res, 200, true, "Login Successful / लॉगिन सफल रहा", {
        token: data.session.access_token,
        refresh_token: data.session.refresh_token,
        expires_at: data.session.expires_at,
        user: {
          id: data.user.id,
          email: data.user.email,
          last_login: data.user.last_sign_in_at,
        },
      });
    } catch (err) {
      console.error("Critical Auth Crash:", err);
      return sendResponse(
        res,
        500,
        false,
        "Internal Server Error / सर्वर त्रुटि: कृपया बाद में प्रयास करें",
      );
    }
  },
);

// --- 2. APPLICATION SUBMISSION API ---

/**
 * @route POST /api/apply
 * @desc Multi-part upload and DB entry
 */
app.post(
  "/api/apply",
  upload.fields([
    { name: "fileAadhaarFront", maxCount: 1 },
    { name: "fileAadhaarBack", maxCount: 1 },
    { name: "fileSignedPhotoStatic", maxCount: 1 },
    { name: "fileParentAadhaar", maxCount: 1 },
    { name: "fileOldDomicile", maxCount: 1 },
    { name: "fileOldCaste", maxCount: 1 },
    { name: "fileOldIncome", maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      const body = req.body;

      // 1. Concurrent File Uploads for Speed
      const fileUploads = {
        file_aadhaar_front: uploadToSupabase(
          req.files["fileAadhaarFront"]?.[0],
          "aadhaar",
        ),
        file_aadhaar_back: uploadToSupabase(
          req.files["fileAadhaarBack"]?.[0],
          "aadhaar",
        ),
        file_signed_photo: uploadToSupabase(
          req.files["fileSignedPhotoStatic"]?.[0],
          "photos",
        ),
        file_parent_aadhaar: uploadToSupabase(
          req.files["fileParentAadhaar"]?.[0],
          "parents",
        ),
        file_old_domicile: uploadToSupabase(
          req.files["fileOldDomicile"]?.[0],
          "old_docs",
        ),
        file_old_caste: uploadToSupabase(
          req.files["fileOldCaste"]?.[0],
          "old_docs",
        ),
        file_old_income: uploadToSupabase(
          req.files["fileOldIncome"]?.[0],
          "old_docs",
        ),
      };

      const urls = {};
      for (const [key, promise] of Object.entries(fileUploads)) {
        urls[key] = await promise;
      }

      // 2. Database Payload
      const payload = {
        ...urls,
        applicant_name: body.appName,
        mobile: body.mobile,
        gender: body.gender,
        document_type: body.documentType,
        referral_code: body.referralCode || "DIRECT",
        submission_date: new Date().toISOString().split("T")[0],
        documents_status: "PENDING",
        payment_status: "PENDING",
      };

      const { data: dbData, error: dbError } = await supabase
        .from("application_entries")
        .insert([payload])
        .select();

      if (dbError) throw dbError;

      // 3. Initiate Cashfree Session (External Vercel Hook)
      const payRes = await axios.post(
        "https://paymentconfig.vercel.app/api/payment/create",
        {
          applicationId: dbData[0].id,
          customerPhone: body.mobile,
          customerName: body.appName,
        },
      );

      return sendResponse(
        res,
        201,
        true,
        "Application Recorded / आवेदन सुरक्षित कर लिया गया है",
        {
          payment_session_id: payRes.data.payment_session_id,
        },
      );
    } catch (err) {
      console.error(err);
      return sendResponse(
        res,
        500,
        false,
        `System Error: ${err.message} / सिस्टम त्रुटि: आवेदन जमा नहीं हो सका`,
      );
    }
  },
);

// --- 3. TRACKING API ---

app.get(
  "/api/track/:mobile",
  [
    param("mobile")
      .isLength({ min: 10, max: 10 })
      .withMessage("Invalid Mobile"),
  ],
  async (req, res) => {
    try {
      const { mobile } = req.params;
      const { data, error } = await supabase
        .from("application_entries")
        .select("*")
        .eq("mobile", mobile)
        .order("created_at", { ascending: false });

      if (error) throw error;
      if (data.length === 0)
        return sendResponse(
          res,
          404,
          false,
          "No records found / कोई रिकॉर्ड नहीं मिला",
        );

      return sendResponse(
        res,
        200,
        true,
        "Records Found / रिकॉर्ड मिल गए हैं",
        data,
      );
    } catch (err) {
      return sendResponse(res, 500, false, "Tracking Error / ट्रैकिंग त्रुटि");
    }
  },
);

app.listen(PORT, () =>
  console.log(`🚀 R2PS Enterprise API running on port ${PORT}`),
);
