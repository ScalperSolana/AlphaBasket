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
    "description": "PolyBaskets USDC escrow program — stores entry/settlement indexes and pays claims by formula"
  },
  "instructions": [
    {
      "name": "claim",
      "docs": [
        "Claim a settled position. Payout = stake * settlement / entry."
      ],
      "discriminator": [
        62,
        198,
        214,
        193,
        213,
        159,
        108,
        210
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
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
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
                "path": "basket.basket_id",
                "account": "basket"
              },
              {
                "kind": "account",
                "path": "claimer"
              }
            ]
          }
        },
        {
          "name": "claimerUsdc",
          "writable": true
        },
        {
          "name": "treasuryUsdc",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "claimer",
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
    },
    {
      "name": "createBasket",
      "docs": [
        "Create a basket and its dedicated USDC vault, storing its composition."
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
                "path": "basketId"
              }
            ]
          }
        },
        {
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
                  116
                ]
              },
              {
                "kind": "arg",
                "path": "basketId"
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "creator",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
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
          "name": "items",
          "type": {
            "vec": {
              "defined": {
                "name": "basketItem"
              }
            }
          }
        }
      ]
    },
    {
      "name": "finalizeSettlement",
      "docs": [
        "Finalize a proposed settlement once the challenge window has elapsed."
      ],
      "discriminator": [
        220,
        72,
        152,
        119,
        178,
        196,
        25,
        170
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
          "name": "oracleAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": []
    },
    {
      "name": "fundBasket",
      "docs": [
        "House liquidity: anyone may fund a basket vault to cover net winnings."
      ],
      "discriminator": [
        6,
        208,
        103,
        40,
        106,
        233,
        112,
        146
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
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
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
          "name": "funderUsdc",
          "writable": true
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "funder",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "initialize",
      "docs": [
        "One-time global config. `admin` is the upgrade/governance key."
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
          "name": "treasuryUsdc",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  116,
                  114,
                  101,
                  97,
                  115,
                  117,
                  114,
                  121,
                  45,
                  117,
                  115,
                  100,
                  99
                ]
              }
            ]
          }
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "admin",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "oracleAuthority",
          "type": "pubkey"
        },
        {
          "name": "quoteSigner",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "proposeSettlement",
      "docs": [
        "Propose the settlement index for a basket, opening the challenge window."
      ],
      "discriminator": [
        228,
        149,
        56,
        61,
        137,
        43,
        106,
        25
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
          "name": "oracleAuthority",
          "signer": true,
          "relations": [
            "config"
          ]
        }
      ],
      "args": [
        {
          "name": "settlementIndexBps",
          "type": "u16"
        }
      ]
    },
    {
      "name": "setAuthorities",
      "docs": [
        "Rotate the oracle authority and/or quote signer. Admin only."
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
          "name": "newOracleAuthority",
          "type": {
            "option": "pubkey"
          }
        },
        {
          "name": "newQuoteSigner",
          "type": {
            "option": "pubkey"
          }
        }
      ]
    },
    {
      "name": "setPaused",
      "docs": [
        "Emergency pause switch (blocks stake + claim). Admin only."
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
      "name": "stake",
      "docs": [
        "Stake USDC into a basket at an Ed25519-signed entry index."
      ],
      "discriminator": [
        206,
        176,
        202,
        18,
        200,
        209,
        179,
        108
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
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
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
                "path": "basket.basket_id",
                "account": "basket"
              },
              {
                "kind": "account",
                "path": "staker"
              }
            ]
          }
        },
        {
          "name": "stakerUsdc",
          "writable": true
        },
        {
          "name": "treasuryUsdc",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "staker",
          "writable": true,
          "signer": true
        },
        {
          "name": "ixSysvar",
          "address": "Sysvar1nstructions1111111111111111111111111"
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        },
        {
          "name": "entryIndexBps",
          "type": "u16"
        },
        {
          "name": "nonce",
          "type": "u64"
        },
        {
          "name": "expiry",
          "type": "i64"
        }
      ]
    },
    {
      "name": "sweepSurplus",
      "docs": [
        "After every recorded position has claimed, transfer the exact remaining",
        "basket-vault surplus to the configured USDC treasury account."
      ],
      "discriminator": [
        144,
        67,
        197,
        177,
        218,
        200,
        50,
        24
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
          "name": "vault",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  118,
                  97,
                  117,
                  108,
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
          "name": "treasuryUsdc",
          "writable": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "usdcMint"
        },
        {
          "name": "admin",
          "signer": true,
          "relations": [
            "config"
          ]
        },
        {
          "name": "tokenProgram",
          "address": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
        }
      ],
      "args": []
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
    }
  ],
  "events": [
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
      "name": "basketSurplusSwept",
      "discriminator": [
        193,
        64,
        173,
        135,
        200,
        164,
        31,
        168
      ]
    },
    {
      "name": "claimed",
      "discriminator": [
        217,
        192,
        123,
        72,
        108,
        150,
        248,
        33
      ]
    },
    {
      "name": "settled",
      "discriminator": [
        232,
        210,
        40,
        17,
        142,
        124,
        145,
        238
      ]
    },
    {
      "name": "settlementProposed",
      "discriminator": [
        139,
        32,
        64,
        205,
        27,
        154,
        100,
        147
      ]
    },
    {
      "name": "staked",
      "discriminator": [
        11,
        146,
        45,
        205,
        230,
        58,
        213,
        240
      ]
    },
    {
      "name": "vaultFunded",
      "discriminator": [
        192,
        119,
        245,
        193,
        55,
        223,
        195,
        50
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
      "name": "basketNotActive",
      "msg": "Basket is not active"
    },
    {
      "code": 6002,
      "name": "alreadySettled",
      "msg": "Basket is already settled"
    },
    {
      "code": 6003,
      "name": "notSettled",
      "msg": "Basket is not settled yet"
    },
    {
      "code": 6004,
      "name": "noActiveProposal",
      "msg": "No settlement has been proposed for this basket"
    },
    {
      "code": 6005,
      "name": "challengeWindowActive",
      "msg": "Challenge window has not elapsed; finalize is not yet allowed"
    },
    {
      "code": 6006,
      "name": "zeroAmount",
      "msg": "Amount must be greater than zero"
    },
    {
      "code": 6007,
      "name": "depositTooSmall",
      "msg": "Deposit is too small after fees"
    },
    {
      "code": 6008,
      "name": "basketDepositLimitExceeded",
      "msg": "This deposit would exceed the 10,000 USDC basket cap"
    },
    {
      "code": 6009,
      "name": "userDepositLimitExceeded",
      "msg": "This deposit would exceed the 500 USDC per-user basket cap"
    },
    {
      "code": 6010,
      "name": "unsupportedMintDecimals",
      "msg": "The configured settlement mint must use six decimals"
    },
    {
      "code": 6011,
      "name": "invalidIndex",
      "msg": "Index must be within 1..=10000"
    },
    {
      "code": 6012,
      "name": "quoteExpired",
      "msg": "Signed quote has expired"
    },
    {
      "code": 6013,
      "name": "quoteNonceReused",
      "msg": "Quote nonce was already used"
    },
    {
      "code": 6014,
      "name": "missingQuoteSignature",
      "msg": "Missing Ed25519 quote signature instruction"
    },
    {
      "code": 6015,
      "name": "malformedQuoteSignature",
      "msg": "Malformed Ed25519 quote signature instruction"
    },
    {
      "code": 6016,
      "name": "unauthorizedQuoteSigner",
      "msg": "Quote was not signed by the configured quote signer"
    },
    {
      "code": 6017,
      "name": "quoteMismatch",
      "msg": "Signed quote does not match the staking parameters"
    },
    {
      "code": 6018,
      "name": "alreadyClaimed",
      "msg": "Position already claimed"
    },
    {
      "code": 6019,
      "name": "outstandingClaims",
      "msg": "All positions must be claimed before the basket surplus can be swept"
    },
    {
      "code": 6020,
      "name": "insufficientVaultLiquidity",
      "msg": "Vault has insufficient USDC to cover this payout"
    },
    {
      "code": 6021,
      "name": "wrongMint",
      "msg": "Token account has the wrong mint"
    },
    {
      "code": 6022,
      "name": "wrongTokenOwner",
      "msg": "Token account has the wrong owner"
    },
    {
      "code": 6023,
      "name": "positionBasketMismatch",
      "msg": "Position does not belong to this basket"
    },
    {
      "code": 6024,
      "name": "invalidBasketItems",
      "msg": "Basket items are missing, too many, or malformed"
    },
    {
      "code": 6025,
      "name": "invalidBasketWeights",
      "msg": "Basket item weights must sum to 10000 bps"
    },
    {
      "code": 6026,
      "name": "mathOverflow",
      "msg": "Arithmetic overflow"
    }
  ],
  "types": [
    {
      "name": "basket",
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
            "name": "creator",
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
            "name": "settlementIndexBps",
            "type": "u16"
          },
          {
            "name": "proposedIndexBps",
            "type": "u16"
          },
          {
            "name": "settlementProposedAt",
            "type": "i64"
          },
          {
            "name": "totalStaked",
            "docs": [
              "Net stake credited after deposit fees; used by payout accounting."
            ],
            "type": "u64"
          },
          {
            "name": "totalDeposited",
            "docs": [
              "Gross deposits before fees; used to enforce the 10,000 USDC basket cap."
            ],
            "type": "u64"
          },
          {
            "name": "totalPositions",
            "type": "u32"
          },
          {
            "name": "claimedPositions",
            "type": "u32"
          },
          {
            "name": "createdAt",
            "type": "i64"
          },
          {
            "name": "items",
            "type": {
              "vec": {
                "defined": {
                  "name": "basketItem"
                }
              }
            }
          },
          {
            "name": "bump",
            "type": "u8"
          },
          {
            "name": "vaultBump",
            "type": "u8"
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
            "name": "basketId",
            "type": {
              "array": [
                "u8",
                32
              ]
            }
          },
          {
            "name": "creator",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "basketItem",
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
            "name": "weightBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "basketStatus",
      "type": {
        "kind": "enum",
        "variants": [
          {
            "name": "active"
          },
          {
            "name": "proposed"
          },
          {
            "name": "settled"
          }
        ]
      }
    },
    {
      "name": "basketSurplusSwept",
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
            "name": "treasury",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "claimed",
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
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "grossPayout",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "netPayout",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "config",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "admin",
            "type": "pubkey"
          },
          {
            "name": "oracleAuthority",
            "type": "pubkey"
          },
          {
            "name": "quoteSigner",
            "type": "pubkey"
          },
          {
            "name": "usdcMint",
            "type": "pubkey"
          },
          {
            "name": "treasuryUsdc",
            "type": "pubkey"
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
      "name": "position",
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
            "name": "stakeAmount",
            "docs": [
              "Net principal credited after deposit fees."
            ],
            "type": "u64"
          },
          {
            "name": "depositedAmount",
            "docs": [
              "Cumulative gross deposits; used to enforce the 500 USDC user cap."
            ],
            "type": "u64"
          },
          {
            "name": "entryIndexBps",
            "type": "u16"
          },
          {
            "name": "lastQuoteNonce",
            "type": "u64"
          },
          {
            "name": "claimed",
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
      "name": "settled",
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
            "name": "settlementIndexBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "settlementProposed",
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
            "name": "settlementIndexBps",
            "type": "u16"
          },
          {
            "name": "proposedAt",
            "type": "i64"
          },
          {
            "name": "finalizeAfter",
            "type": "i64"
          }
        ]
      }
    },
    {
      "name": "staked",
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
            "name": "owner",
            "type": "pubkey"
          },
          {
            "name": "grossAmount",
            "type": "u64"
          },
          {
            "name": "feeAmount",
            "type": "u64"
          },
          {
            "name": "netAmount",
            "type": "u64"
          },
          {
            "name": "entryIndexBps",
            "type": "u16"
          }
        ]
      }
    },
    {
      "name": "vaultFunded",
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
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ],
  "constants": [
    {
      "name": "challengeWindowSecs",
      "docs": [
        "Settlement challenge window: the delay (in seconds) that must elapse between",
        "propose_settlement and finalize_settlement. 12 minutes in production."
      ],
      "type": "i64",
      "value": "720"
    }
  ]
};
