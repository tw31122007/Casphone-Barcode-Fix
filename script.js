// ==UserScript==
// @name         POS Barcode Sheet Helper
// @namespace    pos.helper
// @version      2.8
// @description  Adds barcode database from Google Sheets, edits name and price – with debounce to avoid partial scans
// @match        https://mybug.com.au/*
// @grant        none
// ==/UserScript==

(function() {
"use strict";

/* ---------------- SETTINGS ---------------- */

const SHEET_ID = "1Oe7tlTp98Tv5QjndWBlTBFd8o4Rw9QqxoDS3M54-fz8";
const GREEN_BARCODE = "20221990";
const DEBUG_MODE = true;          // Set false to hide debug output
const DEBOUNCE_DELAY = 800;       // Milliseconds to wait after last keystroke before auto-processing

/* ------------------------------------------ */

let barcodeDB = {};
let pendingItem = null;
let observer = null;
let scanTimeout = null;            // For debouncing input

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
    setTimeout(() => {
        debug("--- Looking for name edit modal ---");
        const modal = document.querySelector('.modal, .dialog, [role="dialog"], .bootstrap-dialog, .ppmw, .modal-content, .modal-dialog');
        if (!modal) { debug("❌ No modal found"); return; }
        debug("✅ Modal found: " + modal.className);
        const allInputs = modal.querySelectorAll('input, textarea');
        debug("Inputs/Textareas: " + allInputs.length);
        allInputs.forEach((inp, i) => debug(`  Input ${i}: type="${inp.type}" id="${inp.id}" value="${inp.value}"`));
        let nameInput = null;
        for (let inp of allInputs) if (inp.value && inp.value.toLowerCase().includes('special item')) { nameInput = inp; debug("Found by value"); break; }
        if (!nameInput) for (let inp of allInputs) { const id = (inp.id||'').toLowerCase(), nm = (inp.name||'').toLowerCase(); if (id.includes('name')||nm.includes('name')||id.includes('product')||nm.includes('product')) { nameInput = inp; debug("Found by id/name"); break; } }
        if (!nameInput) { nameInput = modal.querySelector('input[type="text"]:not([disabled]), textarea:not([disabled])'); if (nameInput) debug("Taking first visible text input"); }
        if (!nameInput) { debug("❌ No name input"); return; }
        debug("✅ Name input identified, current: " + nameInput.value);
        nameInput.focus();
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
                debug("✅ Name update completed. Waiting before price update...");
                setTimeout(() => setPriceViaDiscount(row, newPrice), 500);
            }, 200);
        } else {
            debug("❌ Save button not found, trying Enter key...");
            nameInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, bubbles: true }));
            setTimeout(() => setPriceViaDiscount(row, newPrice), 500);
        }
    }, 1000);
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

    let attempts = 0;
    const maxAttempts = 6;
    const checkModal = setInterval(() => {
        attempts++;
        debug(`Modal search attempt ${attempts}/${maxAttempts}`);

        let modal = document.querySelector('.modal.bootstrap-dialog, .bootstrap-dialog, .modal, .modal-dialog, .modal-content, [role="dialog"]');

        if (modal) {
            clearInterval(checkModal);
            debug("✅ Discount modal found: " + modal.className);

            const allButtons = modal.querySelectorAll('button, input[type="button"]');
            debug("Buttons in modal: " + allButtons.length);
            allButtons.forEach((btn, i) => debug(`  Button ${i}: text="${btn.innerText}" class="${btn.className}"`));

            const allInputs = modal.querySelectorAll('input');
            debug("Inputs in modal: " + allInputs.length);
            allInputs.forEach((inp, i) => debug(`  Input ${i}: type="${inp.type}" id="${inp.id}" placeholder="${inp.placeholder}" value="${inp.value}"`));

            const overrideBtn = Array.from(allButtons).find(btn => btn.innerText && btn.innerText.toLowerCase().includes('override'));
            if (overrideBtn) {
                debug("✅ Override button found, clicking...");
                overrideBtn.click();
                setTimeout(() => fillPriceAndSave(modal, newPrice), 200);
            } else {
                debug("ℹ️ Override button not found, proceeding directly");
                fillPriceAndSave(modal, newPrice);
            }
        } else if (attempts >= maxAttempts) {
            clearInterval(checkModal);
            debug("❌ Discount modal not found after " + maxAttempts + " attempts");
        }
    }, 500);
}

function fillPriceAndSave(modal, newPrice) {
    debug("--- Filling price and saving ---");
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
        priceInput = modal.querySelector('input[type="text"]:not([disabled]), input[type="number"]:not([disabled])');
    }
    if (!priceInput) {
        debug("❌ Price input not found");
        return;
    }
    debug("✅ Price input found: current value: " + priceInput.value);
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
                setTimeout(() => editProductNameViaModal(row, newName, newPrice), 500);
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

    // Clear any pending timeout when Enter is pressed manually
    input.addEventListener("keydown", function(e){
        if(e.key === 'Enter'){
            clearTimeout(scanTimeout); // Cancel any scheduled auto-process
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

    // Debounced input handler – waits for typing to pause
    input.addEventListener("input", function(){
        clearTimeout(scanTimeout);
        const currentValue = input.value.trim();

        // Only schedule if the current value matches a barcode in the database
        if (barcodeDB[currentValue]) {
            debug(`Scheduling check for "${currentValue}" after ${DEBOUNCE_DELAY}ms pause`);
            scanTimeout = setTimeout(() => {
                // Verify that the value hasn't changed during the pause
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
