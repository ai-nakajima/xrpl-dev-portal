const set_up_tx_sender = async function() {
  //////////////////////////////////////////////////////////////////////////////
  // Connection / Setup
  //////////////////////////////////////////////////////////////////////////////

  FAUCET_URL = "https://faucet.altnet.rippletest.net/accounts"
  TESTNET_URL = "wss://s.altnet.rippletest.net:51233"

  let connection_ready = false

  let sending_address
  let sending_secret
  let xrp_balance

  console.debug("Getting a sending address from the faucet...")

  faucet_response = function(data) {
    sending_address = data.account.address
    sending_secret = data.account.secret
    xrp_balance = Number(data.balance) // Faucet only delivers ~10,000 XRP,
                                       // so this won't go over JavaScript's
                                       // 64-bit double precision

    $("#balance-item").text(xrp_balance) + " drops"
    $(".sending-address-item").text(sending_address)
  }

  // TEMP: reuse same address for testing
  faucet_response({account:{address:"r6f2viHtMjNSfERbZmXXkJnMmkBAN6d9X", secret:"spyTc4y4GAQwBfQHCxiJ1Xd2mmnM2"},balance:10000})

  // POST-TEMP: Version that actually uses the faucet on every run:
  // $.ajax({
  //   url: FAUCET_URL,
  //   type: 'POST',
  //   dataType: 'json',
  //   success: faucet_response,
  //   error: function() {
  //     alert("There was an error with the XRP Ledger Test Net Faucet. Reload this page to try again.");
  //   }
  // })
  //

  api = new ripple.RippleAPI({server: TESTNET_URL})
  api.on('connected', () => {
    connection_ready = true
    $("#connection-status-item").text("Connected")
    $("#connection-status-item").removeClass("disabled").addClass("active")
  })
  api.on('disconnected', (code) => {
    connection_ready = false
    $("#connection-status-item").text("Not connected")
    $("#connection-status-item").removeClass("active").addClass("disabled")
  })
  console.log("Connecting to Test Net WebSocket...")
  api.connect()

  //////////////////////////////////////////////////////////////////////////////
  // Generic Transaction Submission
  //////////////////////////////////////////////////////////////////////////////

  // Helper function for await-able timeouts
  function timeout(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  const INTERVAL = 1000 // milliseconds to wait for new ledger versions
  async function verify_transaction(hash, options) {
    try {
      data = await api.getTransaction(hash, options)
      return data
    } catch(error) {
      /* If transaction not in latest validated ledger,
         try again until max ledger hit */
      if (error instanceof api.errors.PendingLedgerVersionError) {
        return new Promise((resolve, reject) => {
          setTimeout(() => verify_transaction(hash, options)
  		                     .then(resolve, reject), INTERVAL)
        })
      } else {
        throw error;
      }
    }
  }

  async function update_xrp_balance() {
    balances = await api.getBalances(sending_address, {currency: "XRP"})
    $("#balance-item").text(balances[0].value)
  }

  async function submit_and_verify(tx_object, use_secret, silent) {
    if (use_secret === undefined) {
      use_secret = sending_secret
    }
    try {
      // Auto-fill fields like Fee and Sequence
      prepared = await api.prepareTransaction(tx_object)
      console.debug("Prepared:", prepared)
    } catch(error) {
      console.log(error)
      if (!silent) { alert("Error preparing tx: "+error) }
      return
    }

    // Determine first and last ledger the tx could be validated in *BEFORE*
    //  signing it.
    const options = {
      minLedgerVersion: (await api.getLedger()).ledgerVersion,
      maxLedgerVersion: prepared.instructions.maxLedgerVersion
    }

    try {
      // Sign, submit
      sign_response = api.sign(prepared.txJSON, use_secret)
      await api.submit(sign_response.signedTransaction)
    } catch (error) {
      console.log(error)
      if (!silent) { alert("Error signing & submitting tx: "+error) }
      return
    }

    // Wait for tx to be in a validated ledger or to expire
    try {
      const data = await verify_transaction(sign_response.id, options)
      const final_result = data.outcome.result
      // TODO: more "notification-like" system
      // TODO: output should link to a tx lookup/explainer
      if (final_result === "tesSUCCESS") {
        if (!silent) { alert("Tx succeeded (hash:"+sign_response.id+")") }
      } else {
        if (!silent) { alert("Tx failed w/ code "+final_result+" (hash: "+sign_response.id+")") }
      }
      update_xrp_balance()
      return data
    } catch(error) {
      console.log(error)
      if (!silent) { alert("Error submitting tx: "+error) }
    }

  }

  //////////////////////////////////////////////////////////////////////////////
  // Issuer Setup for Partial Payments
  // (Partial payments must involve at least one issued currency, so we set up
  //  an issuer for a fake currency to ripple through.)
  //////////////////////////////////////////////////////////////////////////////

  let pp_issuer_address
  let pp_sending_currency = "BAR"
  async function set_up_for_partial_payments() {
    while (!connection_ready) {
      console.debug("... waiting for connection before doing partial payment setup")
      await timeout(200)
    }
    console.debug("Starting partial payment setup...")
    $("#pp_progress .progress-bar").addClass("progress-bar-animated")
    // 1. Get a funded address to use as issuer
    let pp_issuer_secret
    try {
      const faucet_response = await ($.ajax({
        url: FAUCET_URL,
        type: 'POST',
        dataType: 'json'
      }))
      pp_issuer_address = faucet_response.account.address
      pp_issuer_secret = faucet_response.account.secret
    } catch(error) {
      console.log("Error getting issuer address for partial payments:", error)
      return
    }
    $("#pp_progress .progress-bar").width("20%")

    // 2. Set DefaultRipple on issuer
    let resp = await submit_and_verify({
      TransactionType: "AccountSet",
      Account: pp_issuer_address,
      SetFlag: 8
    }, pp_issuer_secret, true)
    if (resp === undefined) {
      console.log("Couldn't set DefaultRipple for partial payment issuer")
      return
    }
    $("#pp_progress .progress-bar").width("40%")

    // 3. Make a trust line from sending address to issuer
    resp = await submit_and_verify({
      TransactionType: "TrustSet",
      Account: sending_address,
      LimitAmount: {
        currency: pp_sending_currency,
        value: "1000000000", // arbitrarily, 1 billion fake currency
        issuer: pp_issuer_address
      }
    }, sending_secret, true)
    if (resp === undefined) {
      console.log("Error making trust line to partial payment issuer")
      return
    }
    $("#pp_progress .progress-bar").width("60%")

    // 4. Issue fake currency to main sending address
    resp = await submit_and_verify({
      TransactionType: "Payment",
      Account: pp_issuer_address,
      Destination: sending_address,
      Amount: {
        currency: pp_sending_currency,
        value: "1000000000",
        issuer: pp_issuer_address
      }
    }, pp_issuer_secret, true)
    if (resp === undefined) {
      console.log("Error sending fake currency from partial payment issuer")
      return
    }
    $("#pp_progress .progress-bar").width("80%")

    // 5. Place offer to buy issued currency for XRP
    // When sending the partial payment, the sender consumes their own offer (!)
    // so they end up paying themselves issued currency then delivering XRP.
    resp = await submit_and_verify({
      TransactionType: "OfferCreate",
      Account: sending_address,
      TakerGets: "1000000000000000", // 1 billion XRP
      TakerPays: {
        currency: pp_sending_currency,
        value: "1000000000",
        issuer: pp_issuer_address
      }
    }, sending_secret, true)
    if (resp === undefined) {
      console.log("Error placing order to enable partial payments")
      return
    }
    $("#pp_progress .progress-bar").width("100%").removeClass("progress-bar-animated")
    $("#pp_progress").hide()

    // Done. Enable "Send Partial Payment" button
    console.log("Done getting ready to send partial payments.")
    $("#send_partial_payment button").prop("disabled",false)
    $("#send_partial_payment button").attr("title", "")
  }
  set_up_for_partial_payments()

  //////////////////////////////////////////////////////////////////////////////
  // Button Handlers
  //////////////////////////////////////////////////////////////////////////////

  // 1. Send XRP Payment Handler -------------------------------------------
  async function on_click_send_xrp_payment(event) {
    const destination_address = $("#destination_address").val()
    const xrp_drops_input = $("#send_xrp_payment_amount").val()
    $("#send_xrp_payment .loader").show()
    $("#send_xrp_payment button").attr("disabled","disabled")
    await submit_and_verify({
      TransactionType: "Payment",
      Account: sending_address,
      Destination: destination_address,
      Amount: xrp_drops_input
    })
    $("#send_xrp_payment .loader").hide()
    $("#send_xrp_payment button").attr("disabled",false)

  }
  $("#send_xrp_payment button").click(on_click_send_xrp_payment)

  // 2. Send Partial Payment Handler ---------------------------------------
  async function on_click_send_partial_payment(event) {
    const destination_address = $("#destination_address").val()
    $("#send_partial_payment .loader").show()
    $("#send_partial_payment button").attr("disabled","disabled")

    // const path_find_result = await api.request("ripple_path_find", {
    //   source_account: sending_address,
    //   destination_account: destination_address,
    //   destination_amount: "-1", // as much XRP as possible
    //   source_currencies: [{currency: pp_sending_currency, issuer: pp_issuer_address}]
    // })
    // console.log("Path find result:", path_find_result)
    // use_path = path_find_result.alternatives[0].paths_computed

    await submit_and_verify({
      TransactionType: "Payment",
      Account: sending_address,
      Destination: destination_address,
      Amount: "1000000000000000", // 1 billion XRP
      SendMax: {
        value: String(Math.random()*.01), // random very small amount
        currency: pp_sending_currency,
        issuer: pp_issuer_address
      },
      Flags: 0x80020000 // tfPartialPayment | tfFullyCanonicalSig
      /*,
      Paths: use_path*/
    })
    $("#send_partial_payment .loader").hide()
    $("#send_partial_payment button").attr("disabled",false)
  }
  $("#send_partial_payment button").click(on_click_send_partial_payment)


  // 3. Create Escrow Handler ----------------------------------------------
  async function on_click_create_escrow(event) {
    const destination_address = $("#destination_address").val()
    const duration_seconds_txt = $("#create_escrow_duration_seconds").val()
    const release_auto = $("#create_escrow_release_automatically").prop("checked")

    const duration_seconds = parseInt(duration_seconds_txt, 10)
    if (duration_seconds === NaN || duration_seconds < 1) {
      alert("Error: Escrow duration must be a positive number of seconds")
      return
    }
    const finish_after = api.iso8601ToRippleTime(Date()) + duration_seconds

    $("#create_escrow .loader").show()
    $("#create_escrow button").attr("disabled","disabled")
    const escrowcreate_tx_data = await submit_and_verify({
      TransactionType: "EscrowCreate",
      Account: sending_address,
      Destination: destination_address,
      Amount: "1000000",
      FinishAfter: finish_after
    })

    if (release_auto) {
      // Wait until there's a ledger with a close time > FinishAfter
      // to submit the EscrowFinish
      $("#escrow_progress .progress-bar").width("0%").addClass("progress-bar-animated")
      $("#escrow_progress").show()
      let seconds_left
      let pct_done
      let latestCloseTimeRipple
      while (true) {
        seconds_left = (finish_after - api.iso8601ToRippleTime(Date()))
        pct_done = Math.min(99, Math.max(0, (1-(seconds_left / duration_seconds)) * 100))
        $("#escrow_progress .progress-bar").width(pct_done+"%")
        if (seconds_left <= 0) {
          // System time has advanced past FinishAfter. But is there a new
          //  enough validated ledger?
          latestCloseTimeRipple = api.iso8601ToRippleTime((await api.getLedger()).closeTime)
          if (latestCloseTimeRipple > finish_after) {
            $("#escrow_progress .progress-bar").width("100%").removeClass("progress-bar-animated")
            break
          }
        }
        // Update the progress bar & check again in 1 second.
        await timeout(1000)
      }
      $("#escrow_progress").hide()

      // Now submit the EscrowFinish
      // Future feature: submit from a different sender, just to prove that
      //   escrows can be finished by a third party
      await submit_and_verify({
        Account: sending_address,
        TransactionType: "EscrowFinish",
        Owner: sending_address,
        OfferSequence: escrowcreate_tx_data.sequence
      })
    }
    $("#create_escrow .loader").hide()
    $("#create_escrow button").attr("disabled",false)
  }
  $("#create_escrow button").click(on_click_create_escrow)

  // 4. Create Payment Channel Handler -------------------------------------
  async function on_click_create_payment_channel(event) {
    const destination_address = $("#destination_address").val()
    const xrp_drops_input = $("#create_payment_channel_amount").val()
    const pubkey = api.deriveKeypair(sending_secret).publicKey
    $("#create_payment_channel .loader").show()
    $("#create_payment_channel button").attr("disabled","disabled")
    await submit_and_verify({
      TransactionType: "PaymentChannelCreate",
      Account: sending_address,
      Destination: destination_address,
      Amount: xrp_drops_input,
      SettleDelay: 30,
      PublicKey: pubkey
    })
    $("#create_payment_channel .loader").hide()
    $("#create_payment_channel button").attr("disabled",false)

    // Future feature: figure out channel ID and enable a button that creates
    //   valid claims for the given payment channel to help test redeeming
  }
  $("#create_payment_channel button").click(on_click_create_payment_channel)


  // 5. Send Issued Currency Handler ---------------------------------------
  async function on_click_send_issued_currency(event) {
    const destination_address = $("#destination_address").val()
    const issue_amount = $("#send_issued_currency_amount").val()
    const issue_code = $("#send_issued_currency_code").text()
    $("#send_issued_currency .loader").show()
    $("#send_issued_currency button").attr("disabled","disabled")
    // Future feature: cross-currency sending with paths?
    await submit_and_verify({
      TransactionType: "Payment",
      Account: sending_address,
      Destination: destination_address,
      Amount: {
        "currency": issue_code,
        "value": issue_amount,
        "issuer": sending_address
      }
    })
    $("#send_issued_currency .loader").hide()
    $("#send_issued_currency button").attr("disabled",false)
  }
  $("#send_issued_currency button").click(on_click_send_issued_currency)

  // 6. Trust For Handler
  async function on_trust_for(event) {
    const destination_address = $("#destination_address").val()
    const trust_limit = $("#trust_for_amount").val()
    const trust_currency_code = $("#trust_for_currency_code").text()
    $("#trust_for .loader").show()
    $("#trust_for button").attr("disabled","disabled")
    await submit_and_verify({
      TransactionType: "TrustSet",
      Account: sending_address,
      LimitAmount: {
        currency: trust_currency_code,
        value: trust_limit,
        issuer: destination_address
      }
    })
    $("#trust_for .loader").hide()
    $("#trust_for button").attr("disabled",false)
  }
  $("#trust_for button").click(on_trust_for)

}


$(document).ready( function() {
  set_up_tx_sender()
} )
