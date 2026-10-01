/**
 * FULFILLMENT HUB - Google Sheets Configuration
 * Replace these values dengan credentials Anda dari Google Cloud Console
 */

const SHEETS_CONFIG = {
      // ✅ STEP 1: Ambil dari Google Cloud Console
      // Format: 1a2b3c4d5e6f7g8h9i0j (copy dari URL sheet)
      SPREADSHEET_ID: 'YOUR_SPREADSHEET_ID_HERE',

      // ✅ STEP 2: Ambil dari Google Cloud Console
      // Format: AIza... (generate dari Service Account JSON)
      API_KEY: 'YOUR_API_KEY_HERE',

      // Sheet names (jangan ubah)
      SHEETS: {
                INCOMING_GOODS: 'incomingGoods',
                DELIVERY_RECORDS: 'deliveryRecords',
                INVOICES: 'invoices',
                USERS: 'users',
                AUDIT_LOG: 'auditLog'
      },

      // Auto-sync interval (ms)
      AUTO_SYNC_INTERVAL: 60000, // Setiap 60 detik

      // Enable/disable features
      ENABLE_AUTO_SYNC: true,
      ENABLE_BACKUP: true,
      ENABLE_AUDIT_LOG: true
};

console.log('[SHEETS-CONFIG] Configuration loaded');
console.log('[SHEETS-CONFIG] Ready to connect to Google Sheets');
console.log('[SHEETS-CONFIG] API_KEY status:',
                SHEETS_CONFIG.API_KEY === 'YOUR_API_KEY_HERE' ? '❌ NOT SET' : '✅ CONFIGURED'
            );
