/**
 * FULFILLMENT HUB - Google Sheets Integration Module
 * Handles all data sync between app and Google Sheets
 */

class SheetsManager {
      constructor(config) {
                this.spreadsheetId = config.SPREADSHEET_ID;
                this.apiKey = config.API_KEY;
                this.sheetsNames = config.SHEETS;
                this.apiUrl = 'https://sheets.googleapis.com/v4/spreadsheets';
                this.isConfigured = this.apiKey !== 'YOUR_API_KEY_HERE';

          console.log('[SheetsManager] Initialized');
                console.log('[SheetsManager] Configured:', this.isConfigured);
      }

    /**
       * Read entire sheet data
       */
    async readSheet(sheetName, range = 'A1:Z1000') {
              if (!this.isConfigured) {
                            console.warn('[SheetsManager] Not configured - returning empty data');
                            return [];
              }

          try {
                        const rangeSpec = `${sheetName}!${range}`;
                        const url = `${this.apiUrl}/${this.spreadsheetId}/values/${encodeURIComponent(rangeSpec)}?key=${this.apiKey}`;

                  console.log(`[SheetsManager] Reading sheet: ${sheetName}`);

                  const response = await fetch(url);
                        if (!response.ok) {
                                          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
                        }

                  const data = await response.json();
                        const values = data.values || [];

                  console.log(`[SheetsManager] OK Read ${values.length} rows from ${sheetName}`);
                        return values;
          } catch (error) {
                        console.error(`[SheetsManager] Error reading sheet ${sheetName}:`, error);
                        return [];
          }
    }

    /**
       * Append row to sheet
       */
    async appendToSheet(sheetName, values) {
              if (!this.isConfigured) {
                            console.warn('[SheetsManager] Not configured - cannot append');
                            return false;
              }

          try {
                        const range = `${sheetName}!A1`;
                        const url = `${this.apiUrl}/${this.spreadsheetId}/values/${range}:append?key=${this.apiKey}&valueInputOption=USER_ENTERED`;

                  const response = await fetch(url, {
                                    method: 'POST',
                                    headers: {
                                                          'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                                          values: [values]
                                    })
                  });

                  if (response.ok) {
                                    console.log(`[SheetsManager] OK Appended row to ${sheetName}`);
                                    return true;
                  } else {
                                    throw new Error(`HTTP ${response.status}`);
                  }
          } catch (error) {
                        console.error(`[SheetsManager] Error appending to ${sheetName}:`, error);
                        return false;
          }
    }

    /**
       * Update cell range in sheet
       */
    async updateSheet(sheetName, range, values) {
              if (!this.isConfigured) {
                            console.warn('[SheetsManager] Not configured - cannot update');
                            return false;
              }

          try {
                        const fullRange = `${sheetName}!${range}`;
                        const url = `${this.apiUrl}/${this.spreadsheetId}/values/${encodeURIComponent(fullRange)}?key=${this.apiKey}&valueInputOption=USER_ENTERED`;

                  const response = await fetch(url, {
                                    method: 'PUT',
                                    headers: {
                                                          'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({
                                                          values: values
                                    })
                  });

                  if (response.ok) {
                                    console.log(`[SheetsManager] OK Updated ${sheetName}!${range}`);
                                    return true;
                  } else {
                                    throw new Error(`HTTP ${response.status}`);
                  }
          } catch (error) {
                        console.error(`[SheetsManager] Error updating sheet:`, error);
                        return false;
          }
    }

    /**
       * Clear sheet (reset all data)
       */
    async clearSheet(sheetName) {
              if (!this.isConfigured) {
                            console.warn('[SheetsManager] Not configured - cannot clear');
                            return false;
              }

          try {
                        const url = `${this.apiUrl}/${this.spreadsheetId}/values/${sheetName}:clear?key=${this.apiKey}`;

                  const response = await fetch(url, {
                                    method: 'POST',
                                    headers: {
                                                          'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({})
                  });

                  if (response.ok) {
                                    console.log(`[SheetsManager] OK Cleared ${sheetName}`);
                                    return true;
                  }
          } catch (error) {
                        console.error(`[SheetsManager] Error clearing sheet:`, error);
                        return false;
          }
    }

    /**
       * Batch update multiple cells
       */
    async batchUpdate(updates) {
              if (!this.isConfigured) {
                            console.warn('[SheetsManager] Not configured - cannot batch update');
                            return false;
              }

          try {
                        const url = `${this.apiUrl}/${this.spreadsheetId}/values:batchUpdate?key=${this.apiKey}`;

                  const data = {
                                    data: updates.map(update => ({
                                                          range: update.range,
                                                          values: update.values
                                    })),
                                    valueInputOption: 'USER_ENTERED'
                  };

                  const response = await fetch(url, {
                                    method: 'POST',
                                    headers: {
                                                          'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify(data)
                  });

                  if (response.ok) {
                                    console.log(`[SheetsManager] OK Batch updated ${updates.length} ranges`);
                                    return true;
                  }
          } catch (error) {
                        console.error('[SheetsManager] Error in batch update:', error);
                        return false;
          }
    }
}

function parseSheetRows(rows, hasHeader = true) {
      if (!rows || rows.length === 0) return [];
      if (!hasHeader) {
                return rows;
      }
      const headers = rows[0];
      const data = [];
      for (let i = 1; i < rows.length; i++) {
                const obj = {};
                for (let j = 0; j < headers.length; j++) {
                              const header = headers[j];
                              const value = rows[i] ? (rows[i][j] || '') : '';
                              if (header === 'items' || header === 'metadata' || header === 'details') {
                                                try {
                                                                      obj[header] = JSON.parse(value);
                                                } catch {
                                                                      obj[header] = value;
                                                }
                              } else {
                                                obj[header] = value;
                              }
                }
                if (Object.values(obj).some(v => v !== '')) {
                              data.push(obj);
                }
      }
      return data;
}

async function loadDataFromSheets(sheetsManager, config) {
      console.log('[DataLoader] Starting data load from Google Sheets...');
      try {
                const incomingGoodsRows = await sheetsManager.readSheet(config.SHEETS.INCOMING_GOODS);
                window.incomingGoods = parseSheetRows(incomingGoodsRows);
                console.log(`[DataLoader] OK Loaded ${window.incomingGoods.length} incoming goods records`);

          const deliveryRows = await sheetsManager.readSheet(config.SHEETS.DELIVERY_RECORDS);
                window.deliveryRecords = parseSheetRows(deliveryRows);
                console.log(`[DataLoader] OK Loaded ${window.deliveryRecords.length} delivery records`);

          const invoicesRows = await sheetsManager.readSheet(config.SHEETS.INVOICES);
                window.invoices = parseSheetRows(invoicesRows);
                console.log(`[DataLoader] OK Loaded ${window.invoices.length} invoice records`);

          const usersRows = await sheetsManager.readSheet(config.SHEETS.USERS);
                window.users = parseSheetRows(usersRows);
                console.log(`[DataLoader] OK Loaded ${window.users.length} user records`);

          const auditRows = await sheetsManager.readSheet(config.SHEETS.AUDIT_LOG);
                window.auditLog = parseSheetRows(auditRows);
                console.log(`[DataLoader] OK Loaded ${window.auditLog.length} audit log entries`);

          console.log('[DataLoader] OK All data loaded successfully from Google Sheets!');
                return true;
      } catch (error) {
                console.error('[DataLoader] Error loading data:', error);
                return false;
      }
}

async function saveIncomingGoodsToSheets(sheetsManager, sheetName) {
      if (!sheetsManager.isConfigured) return false;
      try {
                console.log('[DataSaver] Saving incoming goods to Sheets...');
                const rows = [
                              ['id', 'receiptNumber', 'supplier', 'items', 'totalQtyRoll', 'totalUnitWeight', 'status', 'receivedAt', 'notes']
                          ];
                for (const item of window.incomingGoods) {
                              rows.push([
                                                item.id || '',
                                                item.receiptNumber || '',
                                                item.supplier || '',
                                                JSON.stringify(item.items || []),
                                                item.totalQtyRoll || 0,
                                                item.totalUnitWeight || 0,
                                                item.status || '',
                                                item.receivedAt || '',
                                                item.notes || ''
                                            ]);
                }
                await sheetsManager.clearSheet(sheetName);
                for (const row of rows) {
                              await sheetsManager.appendToSheet(sheetName, row);
                }
                console.log(`[DataSaver] OK Saved ${window.incomingGoods.length} incoming goods to Sheets`);
                return true;
      } catch (error) {
                console.error('[DataSaver] Error saving incoming goods:', error);
                return false;
      }
}

async function saveDeliveryRecordsToSheets(sheetsManager, sheetName) {
      if (!sheetsManager.isConfigured) return false;
      try {
                console.log('[DataSaver] Saving delivery records to Sheets...');
                const rows = [
                              ['sjNumber', 'date', 'customerName', 'destination', 'items', 'totalQtyRoll', 'status', 'generatedAt', 'printedAt', 'deliveredAt', 'documentReturnedAt']
                          ];
                for (const record of window.deliveryRecords) {
                              rows.push([
                                                record.sjNumber || '',
                                                record.date || '',
                                                record.customerName || '',
                                                record.destination || '',
                                                JSON.stringify(record.items || []),
                                                record.totalQtyRoll || 0,
                                                record.status || '',
                                                record.generatedAt || '',
                                                record.printedAt || '',
                                                record.deliveredAt || '',
                                                record.documentReturnedAt || ''
                                            ]);
                }
                await sheetsManager.clearSheet(sheetName);
                for (const row of rows) {
                              await sheetsManager.appendToSheet(sheetName, row);
                }
                console.log(`[DataSaver] OK Saved ${window.deliveryRecords.length} delivery records to Sheets`);
                return true;
      } catch (error) {
                console.error('[DataSaver] Error saving delivery records:', error);
                return false;
      }
}

async function initializeSheetsIntegration() {
      console.log('[SheetsIntegration] Initializing...');
      const sheetsManager = new SheetsManager(SHEETS_CONFIG);
      window.sheetsManager = sheetsManager;
      if (!window.incomingGoods) window.incomingGoods = [];
      if (!window.deliveryRecords) window.deliveryRecords = [];
      if (!window.invoices) window.invoices = [];
      if (!window.users) window.users = [];
      if (!window.auditLog) window.auditLog = [];
      if (sheetsManager.isConfigured) {
                await loadDataFromSheets(sheetsManager, SHEETS_CONFIG);
      } else {
                console.warn('[SheetsIntegration] Google Sheets not configured');
                console.warn('[SheetsIntegration] Please set SPREADSHEET_ID and API_KEY in sheets-config.js');
      }
      if (SHEETS_CONFIG.ENABLE_AUTO_SYNC) {
                setInterval(() => {
                              if (sheetsManager.isConfigured) {
                                                console.log('[AutoSync] Syncing data to Google Sheets...');
                                                saveIncomingGoodsToSheets(sheetsManager, SHEETS_CONFIG.SHEETS.INCOMING_GOODS);
                                                saveDeliveryRecordsToSheets(sheetsManager, SHEETS_CONFIG.SHEETS.DELIVERY_RECORDS);
                              }
                }, SHEETS_CONFIG.AUTO_SYNC_INTERVAL);
      }
      console.log('[SheetsIntegration] OK Ready to sync data');
      return sheetsManager;
}

console.log('[sheets-integration.js] Module loaded successfully');
