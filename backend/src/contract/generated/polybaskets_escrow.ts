/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/polybaskets_escrow.json`.
 */
export type PolybasketsEscrow = {
  "address": "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm",
  "metadata": {
    "name": "polybasketsEscrow",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "AlphaBasket v2 internal-share accounting and backend-authorized settlement program"
  },
  "instructions": [
    {
      "name": "acceptAdmin",
      "docs": [
        "Accepts administrator authority as the proposed key."
      ],
      "discriminator": [
        112,
        42,
        45,
        90,
        116,
        181,
        13,
        170
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "pendingAdmin",
          "signer": true
        }
      ],
      "args": []
    },
    {
      "name": "accrueManagementFee",
      "docs": [
        "Permissionless crank; dilution is proportional to exact elapsed seconds."
      ],
      "discriminator": [
        91,
        57,
        239,
        81,
        27,
        216,
        220,
        148
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        }
      ],
      "args": []
    },
    {
      "name": "beginReconstitution",
      "docs": [
        "Moves an eligible perpetual basket into reconstitution."
      ],
      "discriminator": [
        41,
        110,
        60,
        3,
        88,
        106,
        37,
        84
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "beginResolution",
      "docs": [
        "Stops deposits and starts resolution for a non-perpetual basket."
      ],
      "discriminator": [
        227,
        106,
        197,
        41,
        160,
        120,
        124,
        182
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "cancelAdminTransfer",
      "docs": [
        "Cancels a pending administrator transfer."
      ],
      "discriminator": [
        38,
        131,
        157,
        31,
        240,
        137,
        44,
        215
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "completeDeposit",
      "docs": [
        "Completes a user-signed deposit after external Polymarket execution."
      ],
      "discriminator": [
        169,
        140,
        35,
        214,
        236,
        133,
        191,
        32
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "basket"
              },
              {
                "kind": "arg",
                "path": "args.user"
              }
            ]
          }
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.execution_batch_hash"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "completeDepositArgs"
            }
          }
        }
      ]
    },
    {
      "name": "completeProtocolFeeWithdrawal",
      "docs": [
        "Redeems accrued protocol dilution shares after external execution."
      ],
      "discriminator": [
        35,
        40,
        178,
        226,
        74,
        194,
        175,
        239
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.execution_batch_hash"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "completeProtocolFeeWithdrawalArgs"
            }
          }
        }
      ]
    },
    {
      "name": "completeReconstitution",
      "docs": [
        "Applies a new Composer-signed canonical composition."
      ],
      "discriminator": [
        236,
        210,
        113,
        243,
        154,
        142,
        102,
        131
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "compositionDraft",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  100,
                  114,
                  97,
                  102,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.composition_hash"
              },
              {
                "kind": "arg",
                "path": "args.composition_nonce"
              }
            ]
          }
        },
        {
          "name": "eligibilityList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.eligibility_hash"
              },
              {
                "kind": "arg",
                "path": "args.eligibility_nonce"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "composerSigner",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "reconstitutionArgs"
            }
          }
        }
      ]
    },
    {
      "name": "completeWithdrawal",
      "docs": [
        "Completes both an active early exit and a final redemption."
      ],
      "discriminator": [
        107,
        98,
        134,
        131,
        74,
        120,
        174,
        121
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "position",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "account",
                "path": "basket"
              },
              {
                "kind": "arg",
                "path": "args.user"
              }
            ]
          }
        },
        {
          "name": "receipt",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  114,
                  101,
                  99,
                  101,
                  105,
                  112,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.execution_batch_hash"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "completeWithdrawalArgs"
            }
          }
        }
      ]
    },
    {
      "name": "createBasket",
      "docs": [
        "Only the configured Composer Service key can create a basket."
      ],
      "discriminator": [
        47,
        105,
        155,
        148,
        15,
        169,
        202,
        211
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.basket_id"
              }
            ]
          }
        },
        {
          "name": "compositionDraft",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  100,
                  114,
                  97,
                  102,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.composition_hash"
              },
              {
                "kind": "arg",
                "path": "args.composition_nonce"
              }
            ]
          }
        },
        {
          "name": "eligibilityList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.eligibility_hash"
              },
              {
                "kind": "arg",
                "path": "args.eligibility_nonce"
              }
            ]
          }
        },
        {
          "name": "composerSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "createBasketArgs"
            }
          }
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "Initializes the singleton configuration under the program upgrade authority."
      ],
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "program",
          "address": "5mzLoAijdzAQV5D7QXe6TTGZ9TkWQanygfnb5VPPxFSm"
        },
        {
          "name": "programData"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "initializeArgs"
            }
          }
        }
      ]
    },
    {
      "name": "proposeAdmin",
      "docs": [
        "Starts the two-step administrator transfer."
      ],
      "discriminator": [
        121,
        214,
        199,
        212,
        87,
        39,
        117,
        234
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newAdmin",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "publishCompositionDraft",
      "docs": [
        "Publishes a creator-selected weighted composition in a size-safe prior transaction."
      ],
      "discriminator": [
        25,
        204,
        60,
        116,
        175,
        6,
        255,
        92
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "compositionDraft",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  109,
                  112,
                  111,
                  115,
                  105,
                  116,
                  105,
                  111,
                  110,
                  95,
                  100,
                  114,
                  97,
                  102,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "args.composition_hash"
              },
              {
                "kind": "arg",
                "path": "args.composition_nonce"
              }
            ]
          }
        },
        {
          "name": "eligibilityList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.eligibility_hash"
              },
              {
                "kind": "arg",
                "path": "args.eligibility_nonce"
              }
            ]
          }
        },
        {
          "name": "composerSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "publishCompositionDraftArgs"
            }
          }
        }
      ]
    },
    {
      "name": "publishEligibilityList",
      "docs": [
        "Publishes a short-lived Composer-screened prediction-market list."
      ],
      "discriminator": [
        90,
        36,
        193,
        106,
        49,
        100,
        73,
        83
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "eligibilityList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  108,
                  105,
                  103,
                  105,
                  98,
                  105,
                  108,
                  105,
                  116,
                  121
                ]
              },
              {
                "kind": "arg",
                "path": "args.list_hash"
              },
              {
                "kind": "arg",
                "path": "args.nonce"
              }
            ]
          }
        },
        {
          "name": "composerSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "publishEligibilityListArgs"
            }
          }
        }
      ]
    },
    {
      "name": "recordFinalSettlement",
      "docs": [
        "Records the final NAV and share snapshot for deterministic redemptions."
      ],
      "discriminator": [
        51,
        17,
        237,
        74,
        237,
        233,
        185,
        80
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "basket",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  98,
                  97,
                  115,
                  107,
                  101,
                  116
                ]
              },
              {
                "kind": "account",
                "path": "basket.basket_id",
                "account": "basket"
              }
            ]
          }
        },
        {
          "name": "backendSigner",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "finalSettlementArgs"
            }
          }
        }
      ]
    },
    {
      "name": "registerToken",
      "docs": [
        "Adds, updates, disables, or re-enables a Jupiter spot-token allowlist entry."
      ],
      "discriminator": [
        32,
        146,
        36,
        240,
        80,
        183,
        36,
        84
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "tokenAllowlist",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  97,
                  108,
                  108,
                  111,
                  119,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "registerTokenArgs"
            }
          }
        }
      ]
    },
    {
      "name": "setAuthorities",
      "docs": [
        "Rotates operational signer and treasury authorities."
      ],
      "discriminator": [
        124,
        254,
        44,
        240,
        197,
        70,
        190,
        107
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "newComposerSigner",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newBackendSigner",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newProtocolTreasury",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "setLimits",
      "docs": [
        "Updates the global user slippage bound."
      ],
      "discriminator": [
        207,
        50,
        250,
        67,
        211,
        33,
        70,
        91
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "maxSlippageBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Pauses or resumes user and execution completion flows."
      ],
      "discriminator": [
        91,
        60,
        125,
        192,
        176,
        225,
        166,
        218
      ],
      "accounts": [
        {
          "name": "config",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "paused",
          "type": "bool"
        }
      ]
    },
    {
      "name": "submitPriceAttestation",
      "docs": [
        "Records a fresh Composer-signed TWAP for a signed-fallback spot token."
      ],
      "discriminator": [
        4,
        29,
        113,
        80,
        88,
        153,
        24,
        4
      ],
      "accounts": [
        {
          "name": "config",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  99,
                  111,
                  110,
                  102,
                  105,
                  103
                ]
              }
            ]
          }
        },
        {
          "name": "tokenAllowlist",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  111,
                  107,
                  101,
                  110,
                  95,
                  97,
                  108,
                  108,
                  111,
                  119,
                  108,
                  105,
                  115,
                  116
                ]
              }
            ]
          }
        },
        {
          "name": "priceAttestation",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  105,
                  99,
                  101,
                  95,
                  97,
                  116,
                  116,
                  101,
                  115,
                  116,
                  97,
                  116,
                  105,
                  111,
                  110
                ]
              },
              {
                "kind": "arg",
                "path": "args.token_mint"
              }
            ]
          }
        },
        {
          "name": "composerSigner",
          "writable": true,
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "args",
          "type": {
            "defined": {
              "name": "submitPriceAttestationArgs"
            }
          }
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "basket",
      "discriminator": [
        219,
        79,
        107,
        135,
        231,
        243,
        218,
        248
      ]
    },
    {
      "name": "compositionDraft",
      "discriminator": [
        229,
        119,
        58,
        168,
        134,
        105,
        155,
        89
      ]
    },
    {
      "name": "config",
      "discriminator": [
        155,
        12,
        170,
        224,
        30,
        250,
        204,
        130
      ]
    },
    {
      "name": "eligibilityList",
      "discriminator": [
        246,
        60,
        135,
        157,
        45,
        199,
        223,
        164
      ]
    },
    {
      "name": "position",
      "discriminator": [
        170,
        188,
        143,
        228,
        122,
        64,
        247,
        208
      ]
    },
    {
      "name": "priceAttestation",
      "discriminator": [
        14,
        221,
        251,
        189,
        238,
        210,
        139,
        75
      ]
    },
    {
      "name": "settlementReceipt",
      "discriminator": [
        52,
        249,
        252,
        121,
        4,
        232,
        187,
        4
      ]
    },
    {
      "name": "tokenAllowlist",
      "discriminator": [
        153,
        168,
        129,
        66,
        180,
        22,
        0,
        239
      ]
    }
  ],
  "events": [
    {
      "name": "adminTransferAccepted",
      "discriminator": [
        79,
        229,
        204,
        202,
        134,
        43,
        177,
        26
      ]
    },
    {
      "name": "adminTransferCancelled",
      "discriminator": [
        93,
        23,
        69,
        55,
        216,
        128,
        106,
        56
      ]
    },
    {
      "name": "adminTransferProposed",
      "discriminator": [
        203,
        168,
        175,
        51,
        239,
        104,
        20,
        85
      ]
    },
    {
      "name": "authoritiesUpdated",
      "discriminator": [
        67,
        41,
        36,
        180,
        223,
        84,
        221,
        76
      ]
    },
    {
      "name": "basketCreated",
      "discriminator": [
        26,
        146,
        108,
        155,
        189,
        85,
        8,
        7
      ]
    },
    {
      "name": "basketReconstituted",
      "discriminator": [
        16,
        150,
        225,
        12,
        4,
        22,
        95,
        171
      ]
    },
    {
      "name": "basketStatusUpdated",
      "discriminator": [
        137,
        129,
        70,
        236,
        181,
        71,
        100,
        217
      ]
    },
    {
      "name": "compositionDraftPublished",
      "discriminator": [
        126,
        168,
        91,
        172,
        81,
        218,
        54,
        128
      ]
    },
    {
      "name": "configInitialized",
      "discriminator": [
        181,
        49,
        200,
        156,
        19,
        167,
        178,
        91
      ]
    },
    {
      "name": "depositSettled",
      "discriminator": [
        154,
        83,
        222,
        39,
        153,
        147,
        84,
        58
      ]
    },
    {
      "name": "eligibilityListPublished",
      "discriminator": [
        83,
        75,
        82,
        229,
        241,
        90,
        84,
        240
      ]
    },
    {
      "name": "finalSettlementRecorded",
      "discriminator": [
        239,
        132,
        242,
        188,
        76,
        223,
        224,
        51
      ]
    },
    {
      "name": "limitsUpdated",
      "discriminator": [
        160,
        131,
        108,
        76,
        91,
        80,
        118,
        137
      ]
    },
    {
      "name": "managementFeeAccrued",
      "discriminator": [
        58,
        154,
        130,
        86,
        156,
        79,
        206,
        166
      ]
    },
    {
      "name": "pauseUpdated",
      "discriminator": [
        203,
        203,
        33,
        225,
        130,
        103,
        90,
        105
      ]
    },
    {
      "name": "priceAttestationSubmitted",
      "discriminator": [
        69,
        65,
        9,
        61,
        104,
        145,
        192,
        154
      ]
    },
    {
      "name": "protocolFeeSharesWithdrawn",
      "discriminator": [
        68,
        102,
        204,
        195,
        221,
        210,
        142,
        244
      ]
    },
    {
      "name": "tokenAllowlistUpdated",
      "discriminator": [
        62,
        137,
        236,
        201,
        142,
        26,
        158,
        148
      ]
    },
    {
      "name": "withdrawalSettled",
      "discriminator": [
        7,
        150,
        114,
        152,
        192,
        118,
        224,
        19
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "paused",
      "msg": "Program is paused"
    },
    {
      "code": 6001,
      "name": "unauthorized",
      "msg": "Authority is not allowed to perform this action"
    },
    {
      "code": 6002,
      "name": "adminTransferNotPending",
      "msg": "No matching admin transfer is pending"
    },
    {
      "code": 6003,
      "name": "zeroAuthority",
      "msg": "Configured authority cannot be the zero public key"
    },
    {
      "code": 6004,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6005,
      "name": "zeroHash",
      "msg": "Hash value cannot be all zeroes"
    },
    {
      "code": 6006,
      "name": "missingCompositionSignature",
      "msg": "Composer signature instruction is missing"
    },
    {
      "code": 6007,
      "name": "malformedCompositionSignature",
      "msg": "Composer signature instruction is malformed"
    },
    {
      "code": 6008,
      "name": "unauthorizedCompositionSigner",
      "msg": "Composition was signed by an unauthorized key"
    },
    {
      "code": 6009,
      "name": "compositionSignatureMismatch",
      "msg": "Signed composition payload does not match the instruction"
    },
    {
      "code": 6010,
      "name": "compositionHashMismatch",
      "msg": "Composition hash does not match the canonical basket items"
    },
    {
      "code": 6011,
      "name": "compositionAuthorizationExpired",
      "msg": "Composition authorization has expired"
    },
    {
      "code": 6012,
      "name": "invalidBasisPoints",
      "msg": "Fee or slippage basis points are outside configured bounds"
    },
    {
      "code": 6013,
      "name": "invalidBasketItems",
      "msg": "Basket items are missing, duplicated, too many, or malformed"
    },
    {
      "code": 6014,
      "name": "invalidBasketWeights",
      "msg": "Basket item weights must sum to 10000 bps"
    },
    {
      "code": 6015,
      "name": "marketWeightExceeded",
      "msg": "A basket item exceeds the per-market weight cap"
    },
    {
      "code": 6016,
      "name": "marketNotEligible",
      "msg": "Selected prediction market is absent from the signed eligibility list"
    },
    {
      "code": 6017,
      "name": "invalidEligibilityList",
      "msg": "Eligibility list is malformed, stale, or does not match its hash"
    },
    {
      "code": 6018,
      "name": "tokenNotAllowlisted",
      "msg": "Spot token is not enabled in the on-chain allowlist"
    },
    {
      "code": 6019,
      "name": "invalidTokenMetadata",
      "msg": "Token allowlist metadata is invalid"
    },
    {
      "code": 6020,
      "name": "invalidPriceAttestation",
      "msg": "Signed spot-price attestation is malformed, stale, or unsupported"
    },
    {
      "code": 6021,
      "name": "priceAttestationNonceNotIncreasing",
      "msg": "Spot-price attestation nonce must increase"
    },
    {
      "code": 6022,
      "name": "invalidBasketStatus",
      "msg": "Basket status does not allow this action"
    },
    {
      "code": 6023,
      "name": "basketNotPerpetual",
      "msg": "Only perpetual baskets can be reconstituted"
    },
    {
      "code": 6024,
      "name": "missingIntentSignature",
      "msg": "User intent signature instruction is missing"
    },
    {
      "code": 6025,
      "name": "malformedIntentSignature",
      "msg": "User intent signature instruction is malformed"
    },
    {
      "code": 6026,
      "name": "unauthorizedIntentSigner",
      "msg": "Intent signature was produced by the wrong user"
    },
    {
      "code": 6027,
      "name": "intentSignatureMismatch",
      "msg": "Signed user intent does not match the completion"
    },
    {
      "code": 6028,
      "name": "intentExpired",
      "msg": "User intent has expired"
    },
    {
      "code": 6029,
      "name": "intentNonceMismatch",
      "msg": "User intent nonce must be exactly the next position nonce"
    },
    {
      "code": 6030,
      "name": "positionMismatch",
      "msg": "Position belongs to a different basket or user"
    },
    {
      "code": 6031,
      "name": "insufficientShares",
      "msg": "Insufficient shares"
    },
    {
      "code": 6032,
      "name": "sharePriceAlreadyInitialized",
      "msg": "The initial $1 share price has already been consumed"
    },
    {
      "code": 6033,
      "name": "compositionVersionMismatch",
      "msg": "Completion uses a stale composition version"
    },
    {
      "code": 6034,
      "name": "feeMismatch",
      "msg": "Protocol fee does not match basket rules"
    },
    {
      "code": 6035,
      "name": "slippageExceeded",
      "msg": "Settlement result exceeds the protocol or user slippage limit"
    },
    {
      "code": 6036,
      "name": "invalidMinimumOutput",
      "msg": "Minimum output does not enforce the requested slippage tolerance"
    },
    {
      "code": 6037,
      "name": "invalidSettlementValues",
      "msg": "Settlement values are internally inconsistent"
    },
    {
      "code": 6038,
      "name": "shareArithmeticMismatch",
      "msg": "Credited shares do not match net value and share price"
    },
    {
      "code": 6039,
      "name": "sharePriceMismatch",
      "msg": "Share price does not match the supplied basket NAV and outstanding shares"
    },
    {
      "code": 6040,
      "name": "settlementNonceNotIncreasing",
      "msg": "Settlement nonce must increase for every basket completion"
    },
    {
      "code": 6041,
      "name": "compositionNonceNotIncreasing",
      "msg": "Composition nonce must increase for every basket composition"
    },
    {
      "code": 6042,
      "name": "finalSnapshotMismatch",
      "msg": "Final settlement snapshot does not match outstanding shares"
    },
    {
      "code": 6043,
      "name": "creatorFeeMismatch",
      "msg": "Creator performance fee does not match realized profit"
    },
    {
      "code": 6044,
      "name": "managementFeeCatchUpTooLarge",
      "msg": "Management-fee catch-up exceeds the supported safety bound"
    },
    {
      "code": 6045,
      "name": "invalidExecutionVersion",
      "msg": "Execution batch uses an unsupported encoding version"
    },
    {
      "code": 6046,
      "name": "invalidExecutionTimestamp",
      "msg": "Execution timestamp must be a valid past or current Unix timestamp"
    },
    {
      "code": 6047,
      "name": "insufficientProtocolFeeShares",
      "msg": "Requested protocol fee shares exceed the accrued balance"
    },
    {
      "code": 6048,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow or underflow"
    }
  ],
  "types": [
    {
      "name": "adminTransferAccepted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "previousAdmin",
            "type": "pubkey"
          },
          {
            "name": "newAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "adminTransferCancelled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "cancelledAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "adminTransferProposed",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "currentAdmin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "allowedToken",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "jupiterVerified",
            "type": "bool"
          },
          {
            "name": "assetClass",
            "type": {
              "defined": {
                "name": "tokenAssetClass"
              }
            }
          },
          {
            "name": "availability",
            "type": {
              "defined": {
                "name": "tradingAvailability"
              }
            }
          },
          {
            "name": "priceSource",
            "type": {
              "defined": {
                "name": "spotPriceSource"
              }
            }
          },
          {
            "name": "backingAttestationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "authoritiesUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "composerSigner",
            "type": "pubkey"
          },
          {
            "name": "backendSigner",
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "basket",
      "docs": [
        "Basket composition, lifecycle, and aggregate share accounting."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "composer",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "creatorFeeDestination",
            "type": "pubkey"
          },
          {
            "name": "protocolFeeDestination",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "basketStatus"
              }
            }
          },
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "compositionVersion",
            "type": "u32"
          },
          {
            "name": "lastCompositionNonce",
            "type": "u64"
          },
          {
            "name": "performanceFeeBps",
            "type": "u16"
          },
          {
            "name": "isPerpetual",
            "type": "bool"
          },
          {
            "name": "reconstitutionCadenceSecs",
            "type": "i64"
          },
          {
            "name": "totalSharesOutstanding",
            "type": "u64"
          },
          {
            "name": "protocolFeeShares",
            "type": "u64"
          },
          {
            "name": "lastManagementFeeAt",
            "type": "i64"
          },
          {
            "name": "managementFeeAccrualRemainder",
            "type": "u128"
          },
          {
            "name": "hasInitializedSharePrice",
            "type": "bool"
          },
          {
            "name": "lastSettlementNonce",
            "type": "u64"
          },
          {
            "name": "grossDepositedValue",
            "type": "u64"
          },
          {
            "name": "finalReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalNavValue",
            "type": "u64"
          },
          {
            "name": "finalShareSnapshot",
            "type": "u64"
          },
          {
            "name": "finalSharesConsumed",
            "type": "u64"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "lastReconstitutionAt",
            "type": "i64"
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "items",
            "type": {
              "vec": {
                "defined": {
                  "name": "basketAsset"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "basketAsset",
      "docs": [
        "One weighted asset in a Composer-signed basket composition."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "string"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "positionKind"
              }
            }
          },
          {
            "name": "weightBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "basketCreated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "basketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "composer",
            "type": "pubkey"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "performanceFeeBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "basketReconstituted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "compositionVersion",
            "type": "u32"
          }
        ]
      }
    },
    {
      "name": "basketStatus",
      "docs": [
        "Lifecycle states for a basket."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "reconstituting"
          },
          {
            "name": "resolving"
          },
          {
            "name": "redeemable"
          },
          {
            "name": "closed"
          }
        ]
      }
    },
    {
      "name": "basketStatusUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "status",
            "type": {
              "defined": {
                "name": "basketStatus"
              }
            }
          }
        ]
      }
    },
    {
      "name": "completeDepositArgs",
      "docs": [
        "User intent and backend result used to complete a deposit. The gross amount",
        "and minimum shares are user-authorized; `net_deposit_value` is the actual",
        "value credited by external execution and backs the minted shares."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "intentExpiry",
            "type": "i64"
          },
          {
            "name": "expectedCompositionVersion",
            "type": "u32"
          },
          {
            "name": "grossAmount",
            "type": "u64"
          },
          {
            "name": "minSharesOut",
            "type": "u64"
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executionVersion",
            "type": "u8"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "navReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settlementNonce",
            "type": "u64"
          },
          {
            "name": "basketNavValue",
            "type": "u64"
          },
          {
            "name": "sharePrice",
            "type": "u64"
          },
          {
            "name": "netDepositValue",
            "type": "u64"
          },
          {
            "name": "sharesCredited",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "completeProtocolFeeWithdrawalArgs",
      "docs": [
        "Backend result used to redeem protocol-owned dilution shares. The gross",
        "realized value is the actual external execution value."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "executionVersion",
            "type": "u8"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "navReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settlementNonce",
            "type": "u64"
          },
          {
            "name": "shareAmount",
            "type": "u64"
          },
          {
            "name": "basketNavValue",
            "type": "u64"
          },
          {
            "name": "sharePrice",
            "type": "u64"
          },
          {
            "name": "grossRealizedValue",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "completeWithdrawalArgs",
      "docs": [
        "User intent and backend result used to complete a withdrawal. The share",
        "amount and minimum value are user-authorized; `gross_realized_value` is the",
        "actual external execution value used for fee and proceeds accounting."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "intentExpiry",
            "type": "i64"
          },
          {
            "name": "expectedCompositionVersion",
            "type": "u32"
          },
          {
            "name": "shareAmount",
            "type": "u64"
          },
          {
            "name": "minValueOut",
            "type": "u64"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "quoteHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executionVersion",
            "type": "u8"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "navReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "settlementNonce",
            "type": "u64"
          },
          {
            "name": "basketNavValue",
            "type": "u64"
          },
          {
            "name": "sharePrice",
            "type": "u64"
          },
          {
            "name": "grossRealizedValue",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "userValueOut",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "compositionDraft",
      "docs": [
        "Composer-published creator selection. Splitting variable-size items into a",
        "prior transaction keeps create/reconstitution transactions under Solana's",
        "packet limit without weakening Ed25519 authorization."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityNonce",
            "type": "u64"
          },
          {
            "name": "compositionNonce",
            "type": "u64"
          },
          {
            "name": "composer",
            "type": "pubkey"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          },
          {
            "name": "items",
            "type": {
              "vec": {
                "defined": {
                  "name": "basketAsset"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "compositionDraftPublished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "compositionDraft",
            "type": "pubkey"
          },
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityNonce",
            "type": "u64"
          },
          {
            "name": "compositionNonce",
            "type": "u64"
          },
          {
            "name": "itemCount",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "config",
      "docs": [
        "Singleton protocol configuration and authority registry."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "pendingAdmin",
            "type": {
              "option": "pubkey"
            }
          },
          {
            "name": "composerSigner",
            "type": "pubkey"
          },
          {
            "name": "backendSigner",
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "maxSlippageBps",
            "type": "u16"
          },
          {
            "name": "accountingDecimals",
            "type": "u8"
          },
          {
            "name": "paused",
            "type": "bool"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "configInitialized",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "composerSigner",
            "type": "pubkey"
          },
          {
            "name": "backendSigner",
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "createBasketArgs",
      "docs": [
        "Composer-authorized basket creation parameters."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityNonce",
            "type": "u64"
          },
          {
            "name": "creator",
            "type": "pubkey"
          },
          {
            "name": "creatorFeeDestination",
            "type": "pubkey"
          },
          {
            "name": "performanceFeeBps",
            "type": {
              "option": "u16"
            }
          },
          {
            "name": "isPerpetual",
            "type": "bool"
          },
          {
            "name": "reconstitutionCadenceSecs",
            "type": "i64"
          },
          {
            "name": "compositionNonce",
            "type": "u64"
          },
          {
            "name": "compositionExpiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "depositSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "intentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "receipt",
            "type": "pubkey"
          },
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "netInvestedValue",
            "type": "u64"
          },
          {
            "name": "sharesCredited",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "eligibilityList",
      "docs": [
        "Short-lived Composer-published market list used by basket creation/reconstitution."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "composer",
            "type": "pubkey"
          },
          {
            "name": "publishedAt",
            "type": "i64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "markets",
            "type": {
              "vec": {
                "defined": {
                  "name": "eligibleMarket"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "eligibilityListPublished",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "eligibilityList",
            "type": "pubkey"
          },
          {
            "name": "listHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "marketCount",
            "type": "u16"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "eligibleMarket",
      "docs": [
        "One prediction market admitted by the Composer's unchanged six-point screen.",
        "Weights are deliberately absent: creators choose them after eligibility is signed."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "marketId",
            "type": "string"
          },
          {
            "name": "outcome",
            "type": "u8"
          },
          {
            "name": "ctfTokenId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "finalSettlementArgs",
      "docs": [
        "Final basket NAV and share-supply snapshot."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "finalReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalNavValue",
            "type": "u64"
          },
          {
            "name": "finalShareSnapshot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "finalSettlementRecorded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "finalReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "finalNavValue",
            "type": "u64"
          },
          {
            "name": "finalShareSnapshot",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "initializeArgs",
      "docs": [
        "Initialization parameters for operational authorities and accounting policy."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "composerSigner",
            "type": "pubkey"
          },
          {
            "name": "backendSigner",
            "type": "pubkey"
          },
          {
            "name": "protocolTreasury",
            "type": "pubkey"
          },
          {
            "name": "settlementMint",
            "type": "pubkey"
          },
          {
            "name": "maxSlippageBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "limitsUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "maxSlippageBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "managementFeeAccrued",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "periods",
            "type": "u64"
          },
          {
            "name": "elapsedSeconds",
            "type": "i64"
          },
          {
            "name": "sharesMinted",
            "type": "u64"
          },
          {
            "name": "protocolFeeShares",
            "type": "u64"
          },
          {
            "name": "totalSharesOutstanding",
            "type": "u64"
          },
          {
            "name": "accruedThrough",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "pauseUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "paused",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "position",
      "docs": [
        "A user's shares, performance-fee basis, and weighted holding timestamp.",
        "`cost_basis_value` is the aggregate HWM/equalization basis of the remaining",
        "shares. Partial redemptions remove only their proportional basis; they do",
        "not raise the per-share basis of unredeemed shares unless those shares also",
        "crystallize a performance fee."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "sharesOwned",
            "type": "u64"
          },
          {
            "name": "costBasisValue",
            "type": "u64"
          },
          {
            "name": "grossDepositedValue",
            "type": "u64"
          },
          {
            "name": "lastIntentNonce",
            "type": "u64"
          },
          {
            "name": "weightedDepositTimestamp",
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "positionKind",
      "docs": [
        "Tagged representation of a supported basket position."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "predictionMarket",
            "fields": [
              {
                "name": "outcome",
                "type": "u8"
              },
              {
                "name": "ctfTokenId",
                "type": {
                  "array": [
                    "u8",
                    32
                  ]
                }
              }
            ]
          },
          {
            "name": "spot",
            "fields": [
              {
                "name": "tokenMint",
                "type": "pubkey"
              }
            ]
          }
        ]
      }
    },
    {
      "name": "priceAttestation",
      "docs": [
        "Latest Composer-signed TWAP fallback for a token without a robust oracle."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "priceValue",
            "docs": [
              "Six-decimal settlement-value price, matching the accounting engine."
            ],
            "type": "u64"
          },
          {
            "name": "confidenceBps",
            "type": "u16"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "validUntil",
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "signer",
            "type": "pubkey"
          },
          {
            "name": "attestationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "priceAttestationSubmitted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "priceAttestation",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "priceValue",
            "type": "u64"
          },
          {
            "name": "confidenceBps",
            "type": "u16"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "validUntil",
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "attestationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          }
        ]
      }
    },
    {
      "name": "protocolFeeSharesWithdrawn",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "receipt",
            "type": "pubkey"
          },
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "sharesRedeemed",
            "type": "u64"
          },
          {
            "name": "grossValue",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "publishCompositionDraftArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityNonce",
            "type": "u64"
          },
          {
            "name": "compositionNonce",
            "type": "u64"
          },
          {
            "name": "items",
            "type": {
              "vec": {
                "defined": {
                  "name": "basketAsset"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "publishEligibilityListArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "listHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "nonce",
            "type": "u64"
          },
          {
            "name": "expiresAt",
            "type": "i64"
          },
          {
            "name": "markets",
            "type": {
              "vec": {
                "defined": {
                  "name": "eligibleMarket"
                }
              }
            }
          }
        ]
      }
    },
    {
      "name": "reconstitutionArgs",
      "docs": [
        "Composer-authorized replacement composition."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "compositionHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "eligibilityNonce",
            "type": "u64"
          },
          {
            "name": "compositionNonce",
            "type": "u64"
          },
          {
            "name": "compositionExpiry",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "registerTokenArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "jupiterVerified",
            "type": "bool"
          },
          {
            "name": "assetClass",
            "type": {
              "defined": {
                "name": "tokenAssetClass"
              }
            }
          },
          {
            "name": "availability",
            "type": {
              "defined": {
                "name": "tradingAvailability"
              }
            }
          },
          {
            "name": "priceSource",
            "type": {
              "defined": {
                "name": "spotPriceSource"
              }
            }
          },
          {
            "name": "backingAttestationHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "enabled",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "settlementAction",
      "docs": [
        "Settlement receipt operation type."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "deposit"
          },
          {
            "name": "userWithdrawal"
          },
          {
            "name": "protocolFeeWithdrawal"
          }
        ]
      }
    },
    {
      "name": "settlementReceipt",
      "docs": [
        "Immutable replay-protected record of a completed accounting settlement."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "intentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "action",
            "type": {
              "defined": {
                "name": "settlementAction"
              }
            }
          },
          {
            "name": "executionVersion",
            "docs": [
              "Version of the canonical external-execution batch encoding."
            ],
            "type": "u8"
          },
          {
            "name": "executionBatchHash",
            "docs": [
              "Hash of all fill markets, outcomes, amounts, prices, and external references."
            ],
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "docs": [
              "Timestamp at which the external execution batch completed."
            ],
            "type": "i64"
          },
          {
            "name": "navReportHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "shareDelta",
            "type": "u64"
          },
          {
            "name": "sharePrice",
            "type": "u64"
          },
          {
            "name": "grossValue",
            "docs": [
              "Actual value credited for a deposit or realized for a withdrawal."
            ],
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "withdrawnCostBasis",
            "type": "u64"
          },
          {
            "name": "realizedProfit",
            "type": "u64"
          },
          {
            "name": "earlyExitValue",
            "type": "u64"
          },
          {
            "name": "matureExitValue",
            "type": "u64"
          },
          {
            "name": "userValueOut",
            "type": "u64"
          },
          {
            "name": "settlementNonce",
            "type": "u64"
          },
          {
            "name": "settledAt",
            "type": "i64"
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "spotPriceSource",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "pyth",
            "fields": [
              {
                "name": "feedId",
                "type": {
                  "array": [
                    "u8",
                    32
                  ]
                }
              }
            ]
          },
          {
            "name": "switchboard",
            "fields": [
              {
                "name": "feed",
                "type": "pubkey"
              }
            ]
          },
          {
            "name": "signedTwap"
          }
        ]
      }
    },
    {
      "name": "submitPriceAttestationArgs",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "priceValue",
            "type": "u64"
          },
          {
            "name": "confidenceBps",
            "type": "u16"
          },
          {
            "name": "observedAt",
            "type": "i64"
          },
          {
            "name": "validUntil",
            "type": "i64"
          },
          {
            "name": "nonce",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "tokenAllowlist",
      "docs": [
        "Admin-maintained spot-token registry. Disabling an entry blocks new",
        "compositions but never changes or liquidates an existing basket."
      ],
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "registeredBy",
            "type": "pubkey"
          },
          {
            "name": "tokens",
            "type": {
              "vec": {
                "defined": {
                  "name": "allowedToken"
                }
              }
            }
          },
          {
            "name": "updatedAt",
            "type": "i64"
          },
          {
            "name": "reserved",
            "type": {
              "array": [
                "u8",
                64
              ]
            }
          },
          {
            "name": "bump",
            "type": "u8"
          }
        ]
      }
    },
    {
      "name": "tokenAllowlistUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "tokenAllowlist",
            "type": "pubkey"
          },
          {
            "name": "tokenMint",
            "type": "pubkey"
          },
          {
            "name": "enabled",
            "type": "bool"
          },
          {
            "name": "jupiterVerified",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "tokenAssetClass",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "crypto"
          },
          {
            "name": "tokenizedEquity"
          },
          {
            "name": "other"
          }
        ]
      }
    },
    {
      "name": "tradingAvailability",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "twentyFourSeven"
          },
          {
            "name": "twentyFourFive"
          }
        ]
      }
    },
    {
      "name": "withdrawalKind",
      "docs": [
        "Whether a redemption occurs while active or against a final snapshot."
      ],
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "final"
          }
        ]
      }
    },
    {
      "name": "withdrawalSettled",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "intentHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "intentNonce",
            "type": "u64"
          },
          {
            "name": "receipt",
            "type": "pubkey"
          },
          {
            "name": "basket",
            "type": "pubkey"
          },
          {
            "name": "user",
            "type": "pubkey"
          },
          {
            "name": "destination",
            "type": "pubkey"
          },
          {
            "name": "executionBatchHash",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "executedAt",
            "type": "i64"
          },
          {
            "name": "sharesDecremented",
            "type": "u64"
          },
          {
            "name": "userValueOut",
            "type": "u64"
          },
          {
            "name": "protocolFee",
            "type": "u64"
          },
          {
            "name": "creatorFee",
            "type": "u64"
          },
          {
            "name": "withdrawnCostBasis",
            "type": "u64"
          },
          {
            "name": "realizedProfit",
            "type": "u64"
          },
          {
            "name": "earlyExitValue",
            "type": "u64"
          },
          {
            "name": "matureExitValue",
            "type": "u64"
          },
          {
            "name": "kind",
            "type": {
              "defined": {
                "name": "withdrawalKind"
              }
            }
          }
        ]
      }
    }
  ]
};
