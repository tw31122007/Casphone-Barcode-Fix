// ==UserScript==
// @name         POS Barcode Sheet Helper
// @namespace    pos.helper
// @version      3.4
// @description  Adds barcode database from Google Sheets, edits name and price – waits dynamically for elements
// @match        https://mybug.com.au/*
// @updateURL    https://raw.githubusercontent.com/tw31122007/Casphone-Barcode-Fix/refs/heads/main/barcode-fix.js
// @downloadURL  https://raw.githubusercontent.com/tw31122007/Casphone-Barcode-Fix/refs/heads/main/barcode-fix.js
// @supportURL   https://github.com/tw31122007/Casphone-Barcode-Fix/issues
// @grant        none
// ==/UserScript==

(function() {
"use strict";

/* ---------------- SETTINGS ---------------- */

const SHEET_ID = "1Oe7tlTp98Tv5QjndWBlTBFd8o4Rw9QqxoDS3M54-fz8";
const GREEN_BARCODE = "20221990";
const DEBUG_MODE = true; // Set false to hide debug output
const DEBOUNCE_DELAY = 800; // Milliseconds to wait after last keystroke before auto-processing
const MAX_WAIT_TIME = 30000; // Maximum time to wait for any modal (milliseconds)
const CHECK_INTERVAL = 500; // How often to check for elements

/* ------------------------------------------ */

let barcodeDB = {};
let pendingItem = null;
let observer = null;
let scanTimeout = null; // For debouncing input

function debug(msg){
    if (!DEBUG_MODE) return;
    let box = document.getElementById("tm_debug");
    if(!box){
        box = document.createElement("div");
        box.id = "tm_debug";
        box.style.position = "fixed";
        box.style.bottom = "10px";
        box.style.right = "10px";
        box.style.background = "black";
        box.style.color = "#00ff00";
        box.style.padding = "10px";
        box.style.zIndex = "999999";
        box.style.fontSize = "12px";
        box.style.maxWidth = "400px";
        box.style.maxHeight = "300px";
        box.style.overflow = "auto";
        box.style.fontFamily = "monospace";
        box.style.whiteSpace = "pre-wrap";
        document.body.appendChild(box);
    }
    const line = document.createElement("div");
    line.textContent = msg;
    box.appendChild(line);
    console.log("[POS Helper] " + msg);
}

// Generic function to wait for an element to appear
function waitForElement(selector, callback, timeout = MAX_WAIT_TIME, interval = CHECK_INTERVAL) {
    const startTime = Date.now();
    const checkExist = setInterval(() => {
        const element = document.querySelector(selector);
        if (element) {
            clearInterval(checkExist);
            debug(`Element found: ${selector}`);
            callback(element);
        } else if (Date.now() - startTime > timeout) {
            clearInterval(checkExist);
            debug(`❌ Timeout waiting for: ${selector}`);
            callback(null);
        }
    }, interval);
}

function waitForElementInContainer(container, selector, callback, timeout = MAX_WAIT_TIME, interval = CHECK_INTERVAL) {
    const startTime = Date.now();
    const checkExist = setInterval(() => {
        const element = container.querySelector(selector);
        if (element) {
            clearInterval(checkExist);
            debug(`Element found in container: ${selector}`);
            callback(element);
        } else if (Date.now() - startTime > timeout) {
            clearInterval(checkExist);
            debug(`❌ Timeout waiting for: ${selector} in container`);
            callback(null);
        }
    }, interval);
}

function loadDatabase(){
    debug("Loading barcode database...");
    fetch(`https://docs.google.com/spreadsheets/d/${SHEET_ID}/gviz/tq?tqx=out:json`)
    .then(res => res.text())
    .then(data => {
        const json = JSON.parse(data.substring(47).slice(0, -2));
        const rows = json.table.rows;
        rows.forEach(row => {
            const name = row.c[0]?.v;
            const barcode = row.c[1]?.v;
            const price = row.c[2]?.v;
            if(!barcode) return;
            barcodeDB[String(barcode).trim()] = { name, price };
        });
        debug("Database loaded. Items: " + Object.keys(barcodeDB).length);
    })
    .catch(err => debug("ERROR loading sheet: " + err));
}

function editProductNameViaModal(row, newName, newPrice) {
    debug("--- Starting product name edit process ---");
    let nameCell = row.querySelector('.editablegrid-product_name');
    if (!nameCell) {
        const cells = row.querySelectorAll('td');
        for (let cell of cells) {
            if (cell.innerText.includes("SPECIAL ITEM GREEN LABEL")) {
                nameCell = cell;
                debug("Found name cell by text content");
                break;
            }
        }
    }
    if (!nameCell) { debug("❌ Could not find name cell"); return; }
    debug("✅ Product name cell found, clicking...");
    nameCell.click();

    waitForElement('.modal, .dialog, [role="dialog"], .bootstrap-dialog, .ppmw, .modal-content, .modal-dialog', function(modal) {
        if (!modal) {
            debug("❌ Name edit modal did not appear in time");
            return;
        }
        debug("✅ Name edit modal found: " + modal.className);

        waitForElementInContainer(modal, 'input[type="text"]:not([disabled])', function(nameInput) {
            if (!nameInput) {
                debug("❌ Name input did not appear in time");
                return;
            }
            debug("✅ Name input found, current value: '" + nameInput.value + "'");

            nameInput.focus();
            setTimeout(() => {
                nameInput.value = newName;
                nameInput.dispatchEvent(new Event('input', { bubbles: true }));
                nameInput.dispatchEvent(new Event('change', { bubbles: true }));
                nameInput.dispatchEvent(new Event('keyup', { bubbles: true }));
                debug("✅ Name set to: " + newName);

                const allButtons = modal.querySelectorAll('button, input[type="button"]');
                debug("Buttons in modal: " + allButtons.length);
                allButtons.forEach((btn, i) => debug(`  Button ${i}: text="${btn.innerText}" class="${btn.className}"`));

                const saveBtn = Array.from(allButtons).find(btn => btn.innerText && btn.innerText.toLowerCase().includes('save'));
                if (saveBtn) {
                    debug("✅ Save button found, clicking...");
                    setTimeout(() => {
                        saveBtn.click();
                        debug("✅ Name update completed. Proceeding to price update...");
                        setTimeout(() => setPriceViaDiscount(row, newPrice), 500);
                    }, 200);
                } else {
                    debug("❌ Save button not found, trying Enter key...");
                    nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
                    setTimeout(() => setPriceViaDiscount(row, newPrice), 500);
                }
            }, 100);
        });
    });
}

function setPriceViaDiscount(row, newPrice) {
    debug("--- Starting price update process ---");
    debug("Looking for discount trigger...");
    let discountTrigger = row.querySelector('.dsc_btn');
    if (!discountTrigger) {
        const allElements = row.querySelectorAll('td, button, span, div, a');
        for (let el of allElements) {
            if ((el.innerText || el.textContent || '').trim() === 'D') {
                discountTrigger = el;
                debug("Found by exact text 'D' in element: " + el.tagName);
                break;
            }
        }
    }
    if (!discountTrigger) {
        debug("❌ Discount trigger not found");
        return;
    }
    debug("Clicking discount trigger...");
    discountTrigger.click();

    // Wait for discount modal
    waitForElement('.modal.bootstrap-dialog, .bootstrap-dialog, .modal, .modal-dialog, .modal-content, [role="dialog"]', function(modal) {
        if (!modal) {
            debug("❌ Discount modal did not appear in time");
            return;
        }
        debug("✅ Discount modal found: " + modal.className);

        const allButtons = modal.querySelectorAll('button, input[type="button"]');
        debug("Buttons in modal: " + allButtons.length);
        allButtons.forEach((btn, i) => debug(`  Button ${i}: text="${btn.innerText}" class="${btn.className}"`));

        const allInputs = modal.querySelectorAll('input');
        debug("Inputs in modal: " + allInputs.length);
        allInputs.forEach((inp, i) => debug(`  Input ${i}: type="${inp.type}" id="${inp.id}" placeholder="${inp.placeholder}" value="${inp.value}"`));

        // Check for Override button
        const overrideBtn = Array.from(allButtons).find(btn => btn.innerText && btn.innerText.toLowerCase().includes('override'));
        if (overrideBtn) {
            debug("✅ Override button found, clicking...");
            overrideBtn.click();

            // After clicking Override, wait for the price input to become enabled
            waitForElementInContainer(modal, 'input[type="text"]:not([disabled]), input[type="number"]:not([disabled])', function(priceInput) {
                if (priceInput) {
                    debug("✅ Price input became enabled");
                    fillPriceAndSave(modal, priceInput, newPrice);
                } else {
                    debug("❌ Price input did not become enabled, falling back");
                    findPriceInputAndSave(modal, newPrice);
                }
            }, MAX_WAIT_TIME, CHECK_INTERVAL);
        } else {
            debug("ℹ️ Override button not found, looking for price input directly");
            waitForElementInContainer(modal, 'input[type="text"]:not([disabled]), input[type="number"]:not([disabled])', function(priceInput) {
                if (priceInput) {
                    debug("✅ Price input found (enabled)");
                    fillPriceAndSave(modal, priceInput, newPrice);
                } else {
                    debug("❌ No enabled input found, trying fallback");
                    findPriceInputAndSave(modal, newPrice);
                }
            }, MAX_WAIT_TIME, CHECK_INTERVAL);
        }
    });
}

function findPriceInputAndSave(modal, newPrice) {
    let priceInput = modal.querySelector('input[placeholder*="price" i], input[name*="price" i], input[id*="price" i]');
    if (!priceInput) {
        const labels = modal.querySelectorAll('label');
        for (let label of labels) {
            if (label.innerText.toLowerCase().includes('new price')) {
                const inputId = label.getAttribute('for');
                if (inputId) priceInput = document.getElementById(inputId);
                if (priceInput) break;
            }
        }
    }
    if (!priceInput) {
        priceInput = modal.querySelector('input[type="text"], input[type="number"]');
    }
    if (!priceInput) {
        debug("❌ Price input not found even in fallback");
        return;
    }
    debug("✅ Price input found via fallback, current value: " + priceInput.value);
    fillPriceAndSave(modal, priceInput, newPrice);
}

function fillPriceAndSave(modal, priceInput, newPrice) {
    debug("--- Filling price and saving ---");
    priceInput.focus();
    priceInput.value = newPrice;
    priceInput.dispatchEvent(new Event('input', { bubbles: true }));
    priceInput.dispatchEvent(new Event('change', { bubbles: true }));
    debug("💰 Price entered: " + newPrice);

    const allButtons = modal.querySelectorAll('button, input[type="button"]');
    const saveBtn = Array.from(allButtons).find(btn => btn.innerText && btn.innerText.toLowerCase().includes('save'));
    if (saveBtn) {
        debug("✅ Save button found, clicking...");
        setTimeout(() => {
            saveBtn.click();
            debug("✅ Price update process completed.");
        }, 200);
    } else {
        debug("❌ Save button not found, trying Enter key...");
        priceInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
    }
}

function setupObserver() {
    if (observer) observer.disconnect();
    observer = new MutationObserver(function(mutations) {
        if (!pendingItem) return;
        const rows = document.querySelectorAll("tr");
        for (const row of rows) {
            if (row.innerText.toLowerCase().includes("special item") && !row.hasAttribute('data-modified')) {
                debug("--- Found special item row ---");
                row.setAttribute('data-modified', 'true');
                const cells = row.querySelectorAll("td");
                debug(`Row has ${cells.length} cells`);
                cells.forEach((cell, index) => debug(`Cell ${index}: "${cell.innerText.trim()}"`));
                const idCell = row.querySelector('.editablegrid-id');
                const itemId = idCell ? idCell.innerText.trim() : null;
                debug(`Item ID: ${itemId}`);
                const newName = pendingItem.name;
                const newPrice = pendingItem.price;
                pendingItem = null;
                debug(`Starting name edit with name: "${newName}", price later: $${newPrice}`);
                setTimeout(() => editProductNameViaModal(row, newName, newPrice), 300);
                break;
            }
        }
    });
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    debug("Observer setup complete");
}

function processBarcode(scannedBarcode){
    const item = barcodeDB[scannedBarcode];
    if(!item) return;
    debug("=== Processing barcode: " + scannedBarcode + " ===");
    debug("Product: " + item.name);
    debug("Price: $" + item.price);
    pendingItem = item;
    const input = document.querySelector("#product_filter");
    if(!input) { debug("❌ Input field not found"); pendingItem = null; return; }
    input.value = GREEN_BARCODE;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    setTimeout(() => {
        const enterEvent = new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true });
        input.dispatchEvent(enterEvent);
        debug("✅ Green barcode submitted");
        setTimeout(() => {
            const greenButton = findGreenButton();
            if (greenButton) { greenButton.click(); debug("✅ Clicked green button fallback"); }
        }, 100);
    }, 100);
}

function findGreenButton() {
    const buttons = document.querySelectorAll('button, input[type="button"], a.button, div[role="button"]');
    for (const button of buttons) {
        const text = (button.innerText || button.value || '').toLowerCase();
        if (text.includes('green') || text.includes('19.90') || text.includes('19,90')) return button;
    }
    return null;
}

function watchScanner(){
    debug("Scanner watcher started");
    const input = document.querySelector("#product_filter");
    if(!input){ debug("❌ Search box not found"); return; }
    let lastScanned = '';

    input.addEventListener("keydown", function(e){
        if(e.key === 'Enter'){
            clearTimeout(scanTimeout);
            const scanned = input.value.trim();
            if(scanned === lastScanned) return;
            lastScanned = scanned;
            debug("Enter pressed with value: " + scanned);
            if(barcodeDB[scanned]){
                e.preventDefault();
                e.stopPropagation();
                processBarcode(scanned);
            }
        }
    });

    input.addEventListener("input", function(){
        clearTimeout(scanTimeout);
        const currentValue = input.value.trim();
        if (barcodeDB[currentValue]) {
            debug(`Scheduling check for "${currentValue}" after ${DEBOUNCE_DELAY}ms pause`);
            scanTimeout = setTimeout(() => {
                if (input.value.trim() === currentValue) {
                    debug(`Debounced: processing barcode "${currentValue}"`);
                    processBarcode(currentValue);
                } else {
                    debug(`Value changed during pause, ignoring`);
                }
            }, DEBOUNCE_DELAY);
        }
    });
}

window.addEventListener("load", function(){
    if (DEBUG_MODE) debug("Tampermonkey script started");
    loadDatabase();
    setTimeout(() => { setupObserver(); watchScanner(); }, 1000);
});

})();
